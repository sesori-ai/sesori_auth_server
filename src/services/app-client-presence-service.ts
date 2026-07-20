import type { DevicePlatform } from "../models/device.js";
import type { DeviceTokenRepository } from "../repositories/device-token-repo.js";

type RegistrationWaiter = {
  userId: string;
  promise: Promise<boolean | null>;
  resolve: (registered: boolean | null) => void;
  timeout: ReturnType<typeof setTimeout>;
  abortSignal: AbortSignal;
  abortListener: () => void;
  settled: boolean;
};

enum OutcomeKind {
  Registered = "registered",
  Aborted = "aborted",
  Deadline = "deadline",
  Error = "error",
}

type ReadOutcome =
  | { kind: OutcomeKind.Registered; registered: boolean }
  | { kind: OutcomeKind.Aborted }
  | { kind: OutcomeKind.Deadline }
  | { kind: OutcomeKind.Error; error: unknown };
type WaitOutcome = Exclude<ReadOutcome, { kind: OutcomeKind.Deadline }>;

/**
 * Thrown by `waitForRegistration` when the initial repository read does not
 * complete before the absolute deadline. Deliberately distinct from a normal
 * wait timeout (which resolves `false`): a deadline hit before the first read
 * settles means absence was never confirmed, and the route surfaces it as a
 * 500 instead of serializing a false `{ registered: false }`.
 */
export class AppClientPresenceInitialReadTimeout extends Error {
  constructor() {
    super("App-client presence initial read exceeded its deadline");
    this.name = "AppClientPresenceInitialReadTimeout";
  }
}

/**
 * Tracks whether a user has at least one registered app-client device token
 * and lets in-flight HTTP long polls wait for the first registration.
 *
 * `#waitersByUserId` is entirely process-local: waiters are only woken on the
 * instance that commits the token upsert, and they do not survive restarts
 * (an open long poll ends with its connection; no wake is delivered).
 * Horizontal scaling requires distributing the wake signal — see
 * AGENTS.md SCALING CONSTRAINTS. State is bounded by concurrent open
 * requests: every completion path funnels through `#completeWaiter`, which
 * removes the waiter and deletes drained per-user entries.
 *
 * Waiter lifecycle (per `waitForRegistration` call):
 *   1. The initial repository read races the absolute deadline and the
 *      caller's abort signal.
 *   2. On a false read, a waiter is stored and a recheck fires immediately to
 *      close the registration-between-read-and-storage race window.
 *   3. `registerToken` resolves all waiters for the user as `true` — but only
 *      after the durable upsert succeeds; a failed upsert wakes no one.
 *   4. The remaining-budget timer resolves `false`; the abort signal resolves
 *      `null` (client gone — the route must not serialize a reply).
 */
export class AppClientPresenceService {
  readonly #deviceTokenRepo: DeviceTokenRepository;
  readonly #waitersByUserId = new Map<string, Set<RegistrationWaiter>>();

  constructor(params: { deviceTokenRepo: DeviceTokenRepository }) {
    this.#deviceTokenRepo = params.deviceTokenRepo;
  }

  /**
   * Durably upserts the device token, then wakes every in-flight waiter for
   * `userId` with `true`. If the upsert throws, no waiter is notified — the
   * database write must succeed before presence is asserted.
   */
  async registerToken(params: { userId: string; token: string; platform: DevicePlatform }): Promise<void> {
    await this.#deviceTokenRepo.upsertToken(params.userId, params.token, params.platform);

    const waiters = this.#waitersByUserId.get(params.userId);
    if (!waiters) {
      return;
    }

    for (const waiter of Array.from(waiters)) {
      this.#completeWaiter(waiter, true);
    }
  }

  async hasRegisteredClient(params: { userId: string }): Promise<boolean> {
    return this.#deviceTokenRepo.hasAnyForUser(params.userId);
  }

  /**
   * Waits up to `timeoutMs` for the user to have at least one registered
   * device token, using a single absolute deadline that starts before the
   * initial read.
   *
   * Returns:
   *   - `true`  — a token exists or was registered during the wait
   *   - `false` — the deadline elapsed after a confirmed absent read
   *   - `null`  — `abortSignal` fired (client disconnected); the caller must
   *               hijack the reply rather than serialize a response
   *
   * Throws `AppClientPresenceInitialReadTimeout` when the deadline elapses
   * before the initial read settles, so unconfirmed absence is never reported
   * as `false`.
   */
  async waitForRegistration(params: {
    userId: string;
    timeoutMs: number;
    abortSignal: AbortSignal;
  }): Promise<boolean | null> {
    if (params.abortSignal.aborted) {
      return null;
    }

    if (params.timeoutMs <= 0) {
      // No wait budget: degrade to an immediate read (no waiter, no deadline
      // race). The route always passes a positive timeout; this is a
      // defensive fallback only.
      return this.#deviceTokenRepo.hasAnyForUser(params.userId);
    }

    const deadline = Date.now() + params.timeoutMs;
    const initialRead = await this.#readUntilDeadline({
      userId: params.userId,
      deadline,
      abortSignal: params.abortSignal,
    });

    switch (initialRead.kind) {
      case OutcomeKind.Registered:
        if (initialRead.registered) {
          return true;
        }
        break;
      case OutcomeKind.Aborted:
        return null;
      case OutcomeKind.Deadline:
        throw new AppClientPresenceInitialReadTimeout();
      case OutcomeKind.Error:
        throw initialRead.error;
    }

    if (params.abortSignal.aborted) {
      return null;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }

    const waiter = this.#createWaiter({
      userId: params.userId,
      timeoutMs: remainingMs,
      abortSignal: params.abortSignal,
    });
    // A registration that committed between the initial false read and waiter
    // storage would never wake this waiter; the recheck observes it.
    const recheck = this.#deviceTokenRepo.hasAnyForUser(params.userId).then<WaitOutcome, WaitOutcome>(
      (registered) => ({ kind: OutcomeKind.Registered, registered }),
      (error: unknown) => ({ kind: OutcomeKind.Error, error }),
    );
    const outcome = await Promise.race([
      waiter.promise.then<WaitOutcome>((registered) =>
        registered === null ? { kind: OutcomeKind.Aborted } : { kind: OutcomeKind.Registered, registered },
      ),
      recheck,
    ]);

    if (outcome.kind === OutcomeKind.Error) {
      this.#completeWaiter(waiter, null);
      throw outcome.error;
    }

    if (outcome.kind === OutcomeKind.Aborted) {
      return null;
    }

    if (outcome.registered) {
      this.#completeWaiter(waiter, true);
      return true;
    }

    return waiter.promise;
  }

  async #readUntilDeadline(params: {
    userId: string;
    deadline: number;
    abortSignal: AbortSignal;
  }): Promise<ReadOutcome> {
    const remainingMs = Math.max(0, params.deadline - Date.now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const repositoryRead = this.#deviceTokenRepo.hasAnyForUser(params.userId).then<ReadOutcome, ReadOutcome>(
      (registered) => ({ kind: OutcomeKind.Registered, registered }),
      (error: unknown) => ({ kind: OutcomeKind.Error, error }),
    );
    const deadline = new Promise<ReadOutcome>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: OutcomeKind.Deadline }), remainingMs);
      timeout.unref?.();
    });
    const abort = new Promise<ReadOutcome>((resolve) => {
      abortListener = () => resolve({ kind: OutcomeKind.Aborted });
      params.abortSignal.addEventListener("abort", abortListener, { once: true });
      if (params.abortSignal.aborted) {
        resolve({ kind: OutcomeKind.Aborted });
      }
    });

    try {
      return await Promise.race([repositoryRead, deadline, abort]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }

      if (abortListener) {
        params.abortSignal.removeEventListener("abort", abortListener);
      }
    }
  }

  #createWaiter(params: { userId: string; timeoutMs: number; abortSignal: AbortSignal }): RegistrationWaiter {
    let resolvePromise!: (registered: boolean | null) => void;
    const promise = new Promise<boolean | null>((resolve) => {
      resolvePromise = resolve;
    });
    // waiterRef breaks the forward reference: the abort listener and timeout
    // callback need the waiter object, but both are created before it can be
    // assembled. The ref is populated below before any event can fire.
    const waiterRef: { value?: RegistrationWaiter } = {};
    const abortListener = () => {
      if (waiterRef.value) {
        this.#completeWaiter(waiterRef.value, null);
      }
    };
    const timeout = setTimeout(() => {
      if (waiterRef.value) {
        this.#completeWaiter(waiterRef.value, false);
      }
    }, params.timeoutMs);
    timeout.unref?.();

    const waiter: RegistrationWaiter = {
      userId: params.userId,
      promise,
      resolve: resolvePromise,
      timeout,
      abortSignal: params.abortSignal,
      abortListener,
      settled: false,
    };
    waiterRef.value = waiter;

    params.abortSignal.addEventListener("abort", abortListener, { once: true });
    const waiters = this.#waitersByUserId.get(params.userId) ?? new Set<RegistrationWaiter>();
    waiters.add(waiter);
    this.#waitersByUserId.set(params.userId, waiters);

    if (params.abortSignal.aborted) {
      this.#completeWaiter(waiter, null);
    }

    return waiter;
  }

  /**
   * Single-completion gate: clears the timer, removes the abort listener,
   * removes the waiter from the per-user set (deleting a drained entry), and
   * resolves its promise. The `settled` flag makes completion idempotent when
   * registration, recheck, timeout, and abort race for the same waiter.
   */
  #completeWaiter(waiter: RegistrationWaiter, registered: boolean | null): void {
    if (waiter.settled) {
      return;
    }

    waiter.settled = true;
    clearTimeout(waiter.timeout);
    waiter.abortSignal.removeEventListener("abort", waiter.abortListener);
    const waiters = this.#waitersByUserId.get(waiter.userId);
    waiters?.delete(waiter);
    if (waiters?.size === 0) {
      this.#waitersByUserId.delete(waiter.userId);
    }

    waiter.resolve(registered);
  }
}

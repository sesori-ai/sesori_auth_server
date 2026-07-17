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

type ReadOutcome =
  | { kind: "registered"; registered: boolean }
  | { kind: "aborted" }
  | { kind: "deadline" }
  | { kind: "error"; error: unknown };
type WaitOutcome = Exclude<ReadOutcome, { kind: "deadline" }>;

export class AppClientPresenceInitialReadTimeout extends Error {
  constructor() {
    super("App-client presence initial read exceeded its deadline");
    this.name = "AppClientPresenceInitialReadTimeout";
  }
}

export class AppClientPresenceService {
  readonly #deviceTokenRepo: DeviceTokenRepository;
  readonly #waitersByUserId = new Map<string, Set<RegistrationWaiter>>();

  constructor(params: { deviceTokenRepo: DeviceTokenRepository }) {
    this.#deviceTokenRepo = params.deviceTokenRepo;
  }

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

  async waitForRegistration(params: {
    userId: string;
    timeoutMs: number;
    abortSignal: AbortSignal;
  }): Promise<boolean | null> {
    if (params.abortSignal.aborted) {
      return null;
    }

    if (params.timeoutMs <= 0) {
      return this.#deviceTokenRepo.hasAnyForUser(params.userId);
    }

    const deadline = Date.now() + params.timeoutMs;
    const initialRead = await this.#readUntilDeadline({
      userId: params.userId,
      deadline,
      abortSignal: params.abortSignal,
    });

    switch (initialRead.kind) {
      case "registered":
        if (initialRead.registered) {
          return true;
        }
        break;
      case "aborted":
        return null;
      case "deadline":
        throw new AppClientPresenceInitialReadTimeout();
      case "error":
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
    const recheck = this.#deviceTokenRepo.hasAnyForUser(params.userId).then<WaitOutcome, WaitOutcome>(
      (registered) => ({ kind: "registered", registered }),
      (error: unknown) => ({ kind: "error", error }),
    );
    const outcome = await Promise.race([
      waiter.promise.then<WaitOutcome>((registered) =>
        registered === null ? { kind: "aborted" } : { kind: "registered", registered },
      ),
      recheck,
    ]);

    if (outcome.kind === "error") {
      this.#completeWaiter(waiter, null);
      throw outcome.error;
    }
    if (outcome.kind === "aborted") {
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
      (registered) => ({ kind: "registered", registered }),
      (error: unknown) => ({ kind: "error", error }),
    );
    const deadline = new Promise<ReadOutcome>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: "deadline" }), remainingMs);
      timeout.unref?.();
    });
    const abort = new Promise<ReadOutcome>((resolve) => {
      abortListener = () => resolve({ kind: "aborted" });
      params.abortSignal.addEventListener("abort", abortListener, { once: true });
      if (params.abortSignal.aborted) {
        resolve({ kind: "aborted" });
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

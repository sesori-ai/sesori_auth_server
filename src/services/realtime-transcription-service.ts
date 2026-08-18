import type { RealtimeTranscriptionClient } from "../clients/realtime-transcription-client.js";
import type { DailyUsageRepository } from "../repositories/daily-usage-repo.js";
import type { GlossaryService } from "./glossary-service.js";
import { RealtimeSessionController } from "./realtime-session-controller.js";
import type {
  RealtimeStartRequest,
  RealtimeTranscriptionPolicy,
  RealtimeTranscriptionSession,
} from "./realtime-transcription-contracts.js";
import { RealtimeAdmissionError, toProviderErrorCode } from "./realtime-transcription-errors.js";
import { withTimeout, type RealtimeTimeoutScheduler } from "./realtime-session-utils.js";
import { RealtimeFinishedReason, RealtimeProtocolErrorCode } from "../types/transcription.js";
import { safeErrorType } from "../lib/errors.js";

export type { RealtimeStartRequest, RealtimeTranscriptionPolicy, RealtimeTranscriptionSession };

export class RealtimeTranscriptionService {
  readonly #realtimeClient: RealtimeTranscriptionClient;
  readonly #glossaryService: GlossaryService;
  readonly #dailyUsageRepo: DailyUsageRepository;
  readonly #policy: RealtimeTranscriptionPolicy;
  readonly #active = new Set<RealtimeTranscriptionSession>();
  readonly #starting = new Set<RealtimeTranscriptionSession>();
  readonly #startingControllers = new Set<RealtimeSessionController>();
  readonly #sessionUserIds = new Map<RealtimeTranscriptionSession, string>();
  readonly #activePerUser = new Map<string, number>();
  readonly #now: () => number;
  readonly #scheduleTimeout: RealtimeTimeoutScheduler | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(deps: {
    readonly realtimeClient: RealtimeTranscriptionClient;
    readonly glossaryService: GlossaryService;
    readonly dailyUsageRepo: DailyUsageRepository;
    readonly policy: RealtimeTranscriptionPolicy;
    /** Session clock seam. Production uses the default wall clock; tests drive pacing deterministically. */
    readonly now?: () => number;
    /** Session deadline seam. Production arms real unref'd timers; tests fire them deterministically. */
    readonly scheduleTimeout?: RealtimeTimeoutScheduler;
  }) {
    this.#realtimeClient = deps.realtimeClient;
    this.#glossaryService = deps.glossaryService;
    this.#dailyUsageRepo = deps.dailyUsageRepo;
    this.#policy = deps.policy;
    this.#now = deps.now ?? (() => Date.now());
    this.#scheduleTimeout = deps.scheduleTimeout;
  }

  get activeSessionCount(): number {
    return this.#active.size;
  }

  async start(request: RealtimeStartRequest): Promise<RealtimeTranscriptionSession> {
    if (this.#disposed) {
      throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.ServiceRestarting);
    }
    throwIfAborted(request.signal);
    // Admission must be decided and counted in one synchronous block, before the first await.
    // The daily budget is read but never reserved, so concurrent starts each observe the same
    // remaining seconds; without a ceiling here a single user could hold as many sessions as the
    // start limiter allows per minute, each with its own client socket, provider socket and timers.
    this.#throwIfAtCapacity(request.userId);

    const controller = new RealtimeSessionController({
      service: this,
      request,
      policy: this.#policy,
      providerLimitSeconds: 1,
      readyLimitReason: RealtimeFinishedReason.SessionLimit,
      remainingAtAdmission: 0,
      now: this.#now,
      scheduleTimeout: this.#scheduleTimeout,
    });
    this.#starting.add(controller);
    this.#startingControllers.add(controller);
    this.#acquireSlot(controller, request.userId);

    try {
      const usedSeconds = await this.#dailyUsageRepo.getDailyTranscriptionSeconds(request.userId);
      this.#throwIfDisposed();
      throwIfAborted(request.signal);
      const remainingBudget = Math.max(0, Math.floor(this.#policy.dailyLimitSeconds - usedSeconds));
      if (remainingBudget === 0) {
        throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.QuotaExhausted);
      }

      const readyLimitSeconds = Math.min(this.#policy.maxSessionSeconds, remainingBudget);
      const readyLimitReason =
        remainingBudget <= this.#policy.maxSessionSeconds
          ? RealtimeFinishedReason.QuotaLimit
          : RealtimeFinishedReason.SessionLimit;
      controller.setAdmission({
        providerLimitSeconds: readyLimitSeconds,
        readyLimitReason,
        remainingAtAdmission: remainingBudget,
      });

      const terms =
        request.projectKey === null
          ? []
          : await this.#glossaryService.getContextWords({ userId: request.userId, projectKey: request.projectKey });
      this.#throwIfDisposed();
      throwIfAborted(request.signal);
      await controller.connect(this.#realtimeClient, terms);
      this.#throwIfDisposed();
      throwIfAborted(request.signal);
      this.#starting.delete(controller);
      this.#startingControllers.delete(controller);
      return controller;
    } catch (error) {
      this.#starting.delete(controller);
      this.#startingControllers.delete(controller);
      this.release(controller);
      controller.forceClose();
      if (error instanceof RealtimeAdmissionError) {
        throw error;
      }
      throw new RealtimeAdmissionError(toProviderErrorCode(error));
    }
  }

  beginShutdown(): void {
    this.#disposed = true;
    for (const session of this.#startingControllers) {
      session.abortStart();
    }
  }

  dispose(): Promise<void> {
    this.beginShutdown();
    this.#disposePromise ??= withTimeout(
      Promise.all(
        [...this.#active].map((session) => (this.#starting.has(session) ? session.closed : session.shutdown())),
      ).then(() => {
        if (this.#active.size > 0) {
          throw new Error("dispose_unresolved");
        }
      }),
      this.#policy.disposeTimeoutMs,
      "dispose_timeout",
    );
    return this.#disposePromise;
  }

  release(session: RealtimeTranscriptionSession): void {
    this.#active.delete(session);
    const userId = this.#sessionUserIds.get(session);
    if (userId === undefined) {
      return;
    }

    this.#sessionUserIds.delete(session);
    const remaining = (this.#activePerUser.get(userId) ?? 1) - 1;
    if (remaining <= 0) {
      // Drop the key rather than leaving a zero so the per-user tally cannot grow unbounded
      // over the process lifetime.
      this.#activePerUser.delete(userId);
      return;
    }

    this.#activePerUser.set(userId, remaining);
  }

  #throwIfAtCapacity(userId: string): void {
    // Refuse with ProviderCapacity: it is retryable and closes 1013, which is the correct client
    // response to a transient concurrency ceiling. QuotaExhausted is nonretryable and would
    // wrongly claim the daily budget is gone, and a new wire code would break protocol v1 clients.
    if (this.#active.size >= this.#policy.maxConcurrentSessions) {
      throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.ProviderCapacity);
    }

    if ((this.#activePerUser.get(userId) ?? 0) >= this.#policy.maxConcurrentSessionsPerUser) {
      throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.ProviderCapacity);
    }
  }

  #acquireSlot(session: RealtimeTranscriptionSession, userId: string): void {
    this.#active.add(session);
    this.#sessionUserIds.set(session, userId);
    this.#activePerUser.set(userId, (this.#activePerUser.get(userId) ?? 0) + 1);
  }

  #throwIfDisposed(): void {
    if (this.#disposed) {
      throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.ServiceRestarting);
    }
  }

  async recordUsage(args: {
    readonly userId: string;
    readonly seconds: number;
    readonly remainingAtAdmission: number;
  }): Promise<number> {
    if (args.seconds <= 0) {
      return args.remainingAtAdmission;
    }

    try {
      const result = await this.#dailyUsageRepo.incrementTranscriptionSeconds(args.userId, args.seconds);
      return remainingSeconds(this.#policy.dailyLimitSeconds, result.newTotal);
    } catch (error) {
      console.error("[RealtimeTranscriptionService] usage_write_failed", { errorType: safeErrorType({ error }) });
      return Math.max(0, Math.floor(args.remainingAtAdmission - args.seconds));
    }
  }
}

function remainingSeconds(dailyLimitSeconds: number, newTotal: number): number {
  return Math.max(0, Math.floor(dailyLimitSeconds - newTotal));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.ServiceRestarting);
  }
}

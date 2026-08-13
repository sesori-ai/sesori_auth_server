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
import { withTimeout } from "./realtime-session-utils.js";
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
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(deps: {
    readonly realtimeClient: RealtimeTranscriptionClient;
    readonly glossaryService: GlossaryService;
    readonly dailyUsageRepo: DailyUsageRepository;
    readonly policy: RealtimeTranscriptionPolicy;
  }) {
    this.#realtimeClient = deps.realtimeClient;
    this.#glossaryService = deps.glossaryService;
    this.#dailyUsageRepo = deps.dailyUsageRepo;
    this.#policy = deps.policy;
  }

  get activeSessionCount(): number {
    return this.#active.size;
  }

  async start(request: RealtimeStartRequest): Promise<RealtimeTranscriptionSession> {
    if (this.#disposed) {
      throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.ServiceRestarting);
    }
    throwIfAborted(request.signal);

    const controller = new RealtimeSessionController({
      service: this,
      request,
      policy: this.#policy,
      providerLimitSeconds: 1,
      readyLimitReason: RealtimeFinishedReason.SessionLimit,
      remainingAtAdmission: 0,
    });
    this.#starting.add(controller);
    this.#startingControllers.add(controller);
    this.#active.add(controller);

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

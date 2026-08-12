import { DailyUsageRepository } from "../repositories/daily-usage-repo.js";
import type { AsyncTranscriptionClient } from "../clients/async-transcription-client.js";
import {
  BadRequestError,
  InternalServerError,
  QuotaExceededError,
  safeErrorType,
  TranscriptionConfigurationError,
  TranscriptionProviderError,
  TranscriptionTimeoutError,
  TranscriptionUnavailableError,
} from "../lib/errors.js";
import { GlossaryService } from "./glossary-service.js";
import type { ProjectKey } from "../models/voice.js";
import { TranscriptionFailure, TranscriptionFailureReason } from "../types/transcription.js";

/**
 * Fallback cooldown for a capacity rejection the provider did not quantify.
 * Deliberately longer than the generic 1-second transient default.
 */
const CAPACITY_FALLBACK_RETRY_AFTER_SECONDS = 5;

/** Raised when the client disconnected, so no response should be written. */
export class TranscriptionCancelledError extends Error {
  constructor() {
    super("transcription_cancelled");
    this.name = "TranscriptionCancelledError";
  }
}

export class VoiceService {
  readonly #transcriptionClient: AsyncTranscriptionClient;
  readonly #glossaryService: GlossaryService;
  readonly #dailyUsageRepo: DailyUsageRepository;
  readonly #dailyLimitSeconds: number;

  constructor(deps: {
    transcriptionClient: AsyncTranscriptionClient;
    glossaryService: GlossaryService;
    dailyUsageRepo: DailyUsageRepository;
    dailyLimitSeconds: number;
  }) {
    this.#transcriptionClient = deps.transcriptionClient;
    this.#glossaryService = deps.glossaryService;
    this.#dailyUsageRepo = deps.dailyUsageRepo;
    this.#dailyLimitSeconds = deps.dailyLimitSeconds;
  }

  /**
   * Runs one async transcription: prechecks the daily quota, resolves the
   * project glossary, delegates to the configured provider, and maps the closed
   * provider failure enum onto the public API contract.
   *
   * Billable usage is recorded best-effort after a successful transcript: an
   * infrastructure failure there degrades the returned remaining-seconds figure
   * rather than discarding work the caller already paid for. The precheck, not
   * this write, is the primary quota gate.
   *
   * Throws `TranscriptionCancelledError` when the caller disconnected, which the
   * route treats as "write no response"; every other failure is an `ApiError`.
   */
  async transcribe(args: {
    userId: string;
    projectKey: ProjectKey | null;
    fileBuffer: Buffer;
    filename: string;
    mimetype: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; dailySecondsRemaining: number }> {
    const usedSeconds = await this.#dailyUsageRepo.getDailyTranscriptionSeconds(args.userId);

    if (usedSeconds >= this.#dailyLimitSeconds) {
      throw new QuotaExceededError({
        service: "transcription",
        debugMessage: `Daily transcription limit reached: ${usedSeconds}/${this.#dailyLimitSeconds}s`,
      });
    }

    const terms = await this.#glossaryService.getContextWords({
      userId: args.userId,
      projectKey: args.projectKey,
    });

    let text: string;
    let durationSeconds: number;
    try {
      ({ text, durationSeconds } = await this.#transcriptionClient.transcribe({
        audio: args.fileBuffer,
        filename: args.filename,
        mimeType: args.mimetype,
        terms,
        signal: args.signal,
      }));
    } catch (error) {
      throw VoiceService.#toApiError(error);
    }

    let dailySecondsRemaining: number;
    try {
      const { previousTotal, newTotal } = await this.#dailyUsageRepo.incrementTranscriptionSeconds(
        args.userId,
        durationSeconds,
      );

      if (previousTotal >= this.#dailyLimitSeconds) {
        console.warn("[VoiceService] transcription_quota_race");
        dailySecondsRemaining = 0;
      } else {
        dailySecondsRemaining = Math.max(0, this.#dailyLimitSeconds - newTotal);
      }
    } catch (error) {
      // Soft-fail: the audio is already transcribed, so an infrastructure
      // failure here must not cost the user their result. The pre-check above
      // remains the primary quota gate.
      console.error("[VoiceService] transcription_usage_write_failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      dailySecondsRemaining = Math.max(0, this.#dailyLimitSeconds - usedSeconds - durationSeconds);
    }

    return { text, dailySecondsRemaining };
  }

  /** Maps the closed provider-neutral failure enum onto the public API contract. */
  static #toApiError(error: unknown): Error {
    if (!(error instanceof TranscriptionFailure)) {
      return new InternalServerError({ debugMessage: "Transcription failed", nestedError: error });
    }

    const cause = { errorType: safeErrorType({ error: error.cause }) };

    switch (error.reason) {
      case TranscriptionFailureReason.InvalidInput:
        return new BadRequestError({ debugMessage: "Provider rejected the audio input", nestedError: cause });
      case TranscriptionFailureReason.Capacity:
        // A rate limit the provider did not put a number on still must not be
        // retried at the generic transient cadence: doing so extends the very
        // cooldown the caller is waiting out.
        return new TranscriptionUnavailableError({
          debugMessage: "Transcription provider capacity exhausted",
          nestedError: cause,
          retryAfterSeconds: error.retryAfterSeconds ?? CAPACITY_FALLBACK_RETRY_AFTER_SECONDS,
        });
      case TranscriptionFailureReason.Unavailable:
        return new TranscriptionUnavailableError({
          debugMessage: "Transcription provider unavailable",
          nestedError: cause,
          retryAfterSeconds: error.retryAfterSeconds,
        });
      case TranscriptionFailureReason.Timeout:
        return new TranscriptionTimeoutError({
          debugMessage: "Transcription provider timed out",
          nestedError: cause,
          retryAfterSeconds: error.retryAfterSeconds,
        });
      case TranscriptionFailureReason.ProviderRejected:
        return new TranscriptionConfigurationError({
          debugMessage: "Transcription provider rejected the request",
          nestedError: cause,
        });
      case TranscriptionFailureReason.MalformedOutput:
        return new TranscriptionProviderError({
          debugMessage: "Transcription provider returned malformed output",
          nestedError: cause,
          retryAfterSeconds: error.retryAfterSeconds,
        });
      case TranscriptionFailureReason.Cancelled:
        return new TranscriptionCancelledError();
      case TranscriptionFailureReason.Internal:
        return new InternalServerError({ debugMessage: "Transcription failed", nestedError: cause });
      default:
        return VoiceService.#assertNeverTranscriptionFailureReason(error.reason);
    }
  }

  static #assertNeverTranscriptionFailureReason(reason: never): never {
    throw new InternalServerError({ debugMessage: `Unhandled transcription failure reason: ${reason}` });
  }
}

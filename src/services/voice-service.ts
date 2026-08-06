import { DailyUsageRepository } from "../repositories/daily-usage-repo.js";
import type { AsyncTranscriptionClient } from "../clients/async-transcription-client.js";
import {
  BadRequestError,
  InternalServerError,
  QuotaExceededError,
  TranscriptionConfigurationError,
  TranscriptionProviderError,
  TranscriptionTimeoutError,
  TranscriptionUnavailableError,
} from "../lib/errors.js";
import { GlossaryService } from "./glossary-service.js";
import type { ProjectKey } from "../models/voice.js";
import { TranscriptionFailure, TranscriptionFailureReason } from "../types/transcription.js";

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

    switch (error.reason) {
      case TranscriptionFailureReason.InvalidInput:
        return new BadRequestError({ debugMessage: "Provider rejected the audio input" });
      case TranscriptionFailureReason.Capacity:
      case TranscriptionFailureReason.Unavailable:
        return new TranscriptionUnavailableError({ debugMessage: "Transcription provider unavailable" });
      case TranscriptionFailureReason.Timeout:
        return new TranscriptionTimeoutError({ debugMessage: "Transcription provider timed out" });
      case TranscriptionFailureReason.ProviderRejected:
        return new TranscriptionConfigurationError({ debugMessage: "Transcription provider rejected the request" });
      case TranscriptionFailureReason.MalformedOutput:
        return new TranscriptionProviderError({ debugMessage: "Transcription provider returned malformed output" });
      case TranscriptionFailureReason.Cancelled:
        return new TranscriptionCancelledError();
      default:
        return new InternalServerError({ debugMessage: "Transcription failed" });
    }
  }
}

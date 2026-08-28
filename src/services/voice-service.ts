import { DailyUsageRepository } from "../repositories/daily-usage-repo.js";
import type { AsyncTranscriptionClient } from "../clients/async-transcription-client.js";
import {
  LegacyTranscriptionError,
  QuotaExceededError,
  TranscriptionConfigurationError,
  TranscriptionInternalError,
  TranscriptionInvalidInputError,
  TranscriptionProviderError,
  TranscriptionQuotaExhaustedError,
  TranscriptionTimeoutError,
  TranscriptionUnavailableError,
  TranscriptionUnusableAudioError,
} from "../lib/errors.js";
import { GlossaryService } from "./glossary-service.js";
import type { ProjectKey } from "../models/voice.js";
import {
  AsyncTranscriptionPublicErrorPolicy,
  TranscriptionFailure,
  TranscriptionFailureReason,
} from "../types/transcription.js";

/**
 * Fallback cooldown for a capacity rejection the provider did not quantify.
 * Deliberately longer than the generic 1-second transient default.
 */
const CAPACITY_FALLBACK_RETRY_AFTER_SECONDS = 5;
const REDACTED_HEADER_VALUE = "[redacted]";
const SENSITIVE_HEADER_NAMES = new Set(["authorization", "cookie", "proxy-authorization"]);

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
  readonly #publicErrorPolicy: AsyncTranscriptionPublicErrorPolicy;

  constructor(deps: {
    transcriptionClient: AsyncTranscriptionClient;
    glossaryService: GlossaryService;
    dailyUsageRepo: DailyUsageRepository;
    dailyLimitSeconds: number;
    publicErrorPolicy: AsyncTranscriptionPublicErrorPolicy;
  }) {
    this.#transcriptionClient = deps.transcriptionClient;
    this.#glossaryService = deps.glossaryService;
    this.#dailyUsageRepo = deps.dailyUsageRepo;
    this.#dailyLimitSeconds = deps.dailyLimitSeconds;
    this.#publicErrorPolicy = deps.publicErrorPolicy;
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
        retryable: false,
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
      throw VoiceService.#toApiError({ error, publicErrorPolicy: this.#publicErrorPolicy });
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

  /** Maps the closed provider-neutral failure enum onto the configured public API contract. */
  static #toApiError(input: { error: unknown; publicErrorPolicy: AsyncTranscriptionPublicErrorPolicy }): Error {
    if (!(input.error instanceof TranscriptionFailure)) {
      return new TranscriptionInternalError({
        debugMessage: "Transcription failed",
        nestedError: redactProviderCause({ cause: input.error }),
      });
    }

    if (input.error.reason === TranscriptionFailureReason.Cancelled) {
      return new TranscriptionCancelledError();
    }

    const cause = redactProviderCause({ cause: input.error.cause });
    switch (input.publicErrorPolicy) {
      // COMPATIBILITY 2026-08-27 (v0.1.0): Released apps expect every OpenAI provider failure to retain
      // HTTP 500/internal_server_error. Keep the detailed reason only for the additive retryable boolean. Remove this
      // branch once OpenAI async rollback support is explicitly retired or a breaking error-contract rollout is approved.
      case AsyncTranscriptionPublicErrorPolicy.LegacyOpenAiV1:
        return new LegacyTranscriptionError({
          retryable: VoiceService.#isRetryable(input.error.reason),
          debugMessage: "Transcription failed",
          nestedError: cause,
        });
      case AsyncTranscriptionPublicErrorPolicy.DetailedV1:
        return VoiceService.#toDetailedApiError({ error: input.error, cause });
      default:
        return VoiceService.#assertNeverPublicErrorPolicy(input.publicErrorPolicy);
    }
  }

  static #toDetailedApiError(input: { error: TranscriptionFailure; cause: unknown }): Error {
    switch (input.error.reason) {
      case TranscriptionFailureReason.InvalidInput:
        return new TranscriptionInvalidInputError({
          debugMessage: "Provider rejected the audio input",
          nestedError: input.cause,
        });
      case TranscriptionFailureReason.UnusableAudio:
        return new TranscriptionUnusableAudioError({
          debugMessage: "Transcription provider returned no usable speech",
          nestedError: input.cause,
        });
      case TranscriptionFailureReason.QuotaExhausted:
        return new TranscriptionQuotaExhaustedError({
          debugMessage: "Transcription provider quota exhausted",
          nestedError: input.cause,
        });
      case TranscriptionFailureReason.Capacity:
        // A rate limit the provider did not put a number on still must not be
        // retried at the generic transient cadence: doing so extends the very
        // cooldown the caller is waiting out.
        return new TranscriptionUnavailableError({
          debugMessage: "Transcription provider capacity exhausted",
          nestedError: input.cause,
          retryAfterSeconds: input.error.retryAfterSeconds ?? CAPACITY_FALLBACK_RETRY_AFTER_SECONDS,
        });
      case TranscriptionFailureReason.Unavailable:
        return new TranscriptionUnavailableError({
          debugMessage: "Transcription provider unavailable",
          nestedError: input.cause,
          retryAfterSeconds: input.error.retryAfterSeconds,
        });
      case TranscriptionFailureReason.Timeout:
        return new TranscriptionTimeoutError({
          debugMessage: "Transcription provider timed out",
          nestedError: input.cause,
          retryAfterSeconds: input.error.retryAfterSeconds,
        });
      case TranscriptionFailureReason.ProviderRejected:
        return new TranscriptionConfigurationError({
          debugMessage: "Transcription provider rejected the request",
          nestedError: input.cause,
        });
      case TranscriptionFailureReason.MalformedOutput:
        return new TranscriptionProviderError({
          debugMessage: "Transcription provider returned malformed output",
          nestedError: input.cause,
          retryAfterSeconds: input.error.retryAfterSeconds,
        });
      case TranscriptionFailureReason.Internal:
        return new TranscriptionInternalError({ debugMessage: "Transcription failed", nestedError: input.cause });
      case TranscriptionFailureReason.Cancelled:
        return new TranscriptionCancelledError();
      default:
        return VoiceService.#assertNeverTranscriptionFailureReason(input.error.reason);
    }
  }

  static #isRetryable(reason: TranscriptionFailureReason): boolean {
    switch (reason) {
      case TranscriptionFailureReason.Capacity:
      case TranscriptionFailureReason.Unavailable:
      case TranscriptionFailureReason.Timeout:
      case TranscriptionFailureReason.MalformedOutput:
        return true;
      case TranscriptionFailureReason.InvalidInput:
      case TranscriptionFailureReason.UnusableAudio:
      case TranscriptionFailureReason.QuotaExhausted:
      case TranscriptionFailureReason.ProviderRejected:
      case TranscriptionFailureReason.Cancelled:
      case TranscriptionFailureReason.Internal:
        return false;
      default:
        return VoiceService.#assertNeverTranscriptionFailureReason(reason);
    }
  }

  static #assertNeverTranscriptionFailureReason(reason: never): never {
    throw new TranscriptionInternalError({ debugMessage: `Unhandled transcription failure reason: ${reason}` });
  }

  static #assertNeverPublicErrorPolicy(policy: never): never {
    throw new TranscriptionInternalError({ debugMessage: `Unhandled transcription public error policy: ${policy}` });
  }
}

function redactProviderCause(input: { cause: unknown }): unknown {
  if (input.cause === null || typeof input.cause !== "object") {
    return input.cause;
  }

  if (input.cause instanceof Error) {
    const redactedCause = redactProviderCause({ cause: input.cause.cause });
    const redactedError = new Error(input.cause.message, { cause: redactedCause });
    redactedError.name = input.cause.name;
    redactedError.stack = input.cause.stack;
    Object.assign(redactedError, input.cause);

    const headers = Reflect.get(input.cause, "headers");
    if (headers !== null && typeof headers === "object") {
      Object.assign(redactedError, { headers: redactHeaders({ headers }) });
    }

    Object.defineProperty(redactedError, "cause", { value: redactedCause, configurable: true, writable: true });
    return redactedError;
  }

  const headers = Reflect.get(input.cause, "headers");
  if (headers === null || typeof headers !== "object") {
    return input.cause;
  }

  return { ...input.cause, headers: redactHeaders({ headers }) };
}

function redactHeaders(input: { headers: object }): Record<PropertyKey, unknown> {
  const redactedHeaders: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(input.headers)) {
    redactedHeaders[key] = isSensitiveHeaderName({ key }) ? REDACTED_HEADER_VALUE : Reflect.get(input.headers, key);
  }

  return redactedHeaders;
}

function isSensitiveHeaderName(input: { key: PropertyKey }): boolean {
  return typeof input.key === "string" && SENSITIVE_HEADER_NAMES.has(input.key.toLowerCase());
}

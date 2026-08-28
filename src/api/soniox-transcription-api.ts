import { z } from "zod";
import { TranscriptionFailure, TranscriptionFailureReason } from "../types/transcription.js";

/**
 * Mandatory validation boundary for every Soniox SDK value the service consumes.
 * The SDK's declared types are not trusted at runtime: a provider change must
 * surface as a controlled `malformed_output` failure, never as an unchecked
 * value flowing into billing or a transcript response.
 */

const transcriptionStatusSchema = z.enum(["queued", "processing", "completed", "error"]);

const completedTranscriptionSchema = z
  .object({
    id: z.string().min(1),
    status: transcriptionStatusSchema,
    // Loose here on purpose: a failed job may echo a meaningless duration, and
    // rejecting it at parse time would mask the real error classification.
    // The strict bound is applied below, only for a completed job.
    audio_duration_ms: z.number().finite().nullish(),
    error_type: z.string().nullish(),
    error_message: z.string().nullish(),
  })
  .loose();

const maxTranscriptCharacters = 1_000_000;
const maxAudioDurationMs = 86_400_000;

const transcriptSchema = z
  .object({
    text: z.string().max(maxTranscriptCharacters),
  })
  .loose();

const uploadedFileSchema = z
  .object({
    id: z.string().min(1),
  })
  .loose();

const createdTranscriptionSchema = z
  .object({
    id: z.string().min(1),
  })
  .loose();

export type ValidatedTranscription = {
  id: string;
  status: z.infer<typeof transcriptionStatusSchema>;
  /** Always present and billable: a completed job without one fails validation. */
  audioDurationMs: number;
};

function fail(reason: TranscriptionFailureReason, cause?: unknown): never {
  throw new TranscriptionFailure(reason, { cause });
}

/**
 * Provider `error_type` values that mean the submitted audio could not be
 * transcribed. Anything else is treated as a configuration/credential problem,
 * which is the safer default because it is not presented as the caller's fault.
 */
const audioRejectionErrorTypes = new Set([
  "bad_audio",
  "invalid_audio",
  "unsupported_audio",
  "audio_too_short",
  "audio_too_long",
]);

const quotaExhaustionErrorTypes = new Set([
  "organization_balance_exhausted",
  "organization_monthly_budget_exhausted",
  "project_monthly_budget_exhausted",
]);

function isAudioRejection(errorType: string | null | undefined): boolean {
  return typeof errorType === "string" && audioRejectionErrorTypes.has(errorType);
}

function isQuotaExhaustion(errorType: string | null | undefined): boolean {
  return typeof errorType === "string" && quotaExhaustionErrorTypes.has(errorType);
}

/** Validates an uploaded file and returns only its ID. */
export function parseUploadedFileId(value: unknown): string {
  const result = uploadedFileSchema.safeParse(value);
  if (!result.success) {
    fail(TranscriptionFailureReason.MalformedOutput, result.error.issues);
  }

  return result.data.id;
}

/**
 * Validates a freshly created transcription job and returns only its ID. Job
 * creation legitimately returns a non-terminal status (`queued`/`processing`),
 * so its status must NOT be asserted here — that is what the wait result is for.
 * Capturing the ID also lets cleanup delete the job if a later step fails.
 */
export function parseCreatedTranscriptionId(value: unknown): string {
  const result = createdTranscriptionSchema.safeParse(value);
  if (!result.success) {
    fail(TranscriptionFailureReason.MalformedOutput, result.error.issues);
  }

  return result.data.id;
}

/**
 * Validates a settled transcription record. A provider-reported `error` status
 * is a provider rejection, not malformed output; a still-running status means
 * the job did not settle within our budget.
 *
 * `expectedId` is the job ID we created. The returned record must carry that
 * same ID: without this check a provider response naming a different job would
 * be accepted, and the caller would then fetch and bill that other job's
 * transcript while cleanup deleted ours.
 */
export function parseTranscription(value: unknown, expectedId: string): ValidatedTranscription {
  const result = completedTranscriptionSchema.safeParse(value);
  if (!result.success) {
    fail(TranscriptionFailureReason.MalformedOutput, result.error.issues);
  }

  const { id, status, audio_duration_ms: audioDurationMs, error_type: errorType } = result.data;
  if (id !== expectedId) {
    fail(TranscriptionFailureReason.MalformedOutput);
  }

  if (status === "error") {
    if (isQuotaExhaustion(errorType)) {
      fail(TranscriptionFailureReason.QuotaExhausted);
    }

    // Distinguish "this audio is unusable" from "our credentials/config are
    // wrong": the former is the caller's 400, the latter an operator 500.
    fail(
      isAudioRejection(errorType)
        ? TranscriptionFailureReason.InvalidInput
        : TranscriptionFailureReason.ProviderRejected,
    );
  }

  if (status !== "completed") {
    fail(TranscriptionFailureReason.Timeout);
  }

  // A completed job must carry a billable duration. Rejecting absent, non-
  // positive, and absurd values here classifies malformed provider output at
  // the adapter boundary rather than leaving it to a later billing step.
  // The maximum is inclusive, matching the existing provider contract.
  if (
    audioDurationMs === null ||
    audioDurationMs === undefined ||
    audioDurationMs <= 0 ||
    audioDurationMs > maxAudioDurationMs
  ) {
    fail(TranscriptionFailureReason.MalformedOutput);
  }

  return { id, status, audioDurationMs };
}

/** Validates a transcript payload and returns only its text. */
export function parseTranscriptText(value: unknown): string {
  const result = transcriptSchema.safeParse(value);
  if (!result.success) {
    fail(TranscriptionFailureReason.MalformedOutput, result.error.issues);
  }

  if (result.data.text.trim().length === 0) {
    fail(TranscriptionFailureReason.UnusableAudio);
  }

  return result.data.text;
}

/**
 * Converts audio duration to whole seconds for the daily quota. Rounds up so a
 * partial second is never billed as zero, matching the OpenAI estimate policy.
 * A provider that omits duration is malformed output rather than a free request.
 */
export function toBillableSeconds(audioDurationMs: number | null): number {
  if (audioDurationMs === null || audioDurationMs <= 0) {
    fail(TranscriptionFailureReason.MalformedOutput);
  }

  // At least one second: a sub-second clip must never bill as free.
  return Math.max(1, Math.ceil(audioDurationMs / 1000));
}

/**
 * Maps a thrown SDK value to a provider-neutral reason. Only stable, structural
 * signals are inspected; raw provider messages never escape this module.
 */
export function toFailureReason(error: unknown): TranscriptionFailureReason {
  if (error instanceof TranscriptionFailure) {
    return error.reason;
  }

  // Deliberately NOT mapped to `cancelled`. Cancellation and our own budget
  // expiry are decided by the client from the signals it owns, before this
  // function is consulted. An abort shape arriving here means neither of those
  // fired, so it is an unexplained transport abort — a transient provider
  // condition, not something the caller asked for.
  if (isAbortLike(error)) {
    return TranscriptionFailureReason.Unavailable;
  }

  if (isTimeoutLike(error)) {
    return TranscriptionFailureReason.Timeout;
  }

  if (readCode(error) === "quota_exceeded") {
    return TranscriptionFailureReason.QuotaExhausted;
  }

  const statusCode = readStatusCode(error);
  if (statusCode === undefined) {
    return TranscriptionFailureReason.Unavailable;
  }

  if (statusCode === 402) {
    return TranscriptionFailureReason.QuotaExhausted;
  }

  if (statusCode === 429) {
    return TranscriptionFailureReason.Capacity;
  }

  if (statusCode === 400 || statusCode === 413 || statusCode === 415 || statusCode === 422) {
    return TranscriptionFailureReason.InvalidInput;
  }

  if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
    return TranscriptionFailureReason.ProviderRejected;
  }

  if (statusCode >= 500) {
    return TranscriptionFailureReason.Unavailable;
  }

  return TranscriptionFailureReason.Internal;
}

/**
 * Reads a provider-stated cooldown from a rate-limited response. `SonioxHttpError`
 * retains the response headers, so a `Retry-After` on a 429 is recoverable here;
 * discarding it would let clients retry into an active provider cooldown.
 *
 * Only the delta-seconds form is honored. The HTTP-date form is deliberately
 * ignored rather than parsed, because a skewed provider clock would otherwise
 * translate into an arbitrary client-visible wait.
 */
export function readProviderRetryAfterSeconds(error: unknown): number | undefined {
  const headers = readHeaders(error);
  if (headers === undefined) {
    return undefined;
  }

  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (typeof raw !== "string") {
    return undefined;
  }

  const seconds = Number(raw.trim());
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    return undefined;
  }

  return seconds;
}

function readHeaders(error: unknown): Record<string, string> | undefined {
  if (typeof error !== "object" || error === null || !("headers" in error)) {
    return undefined;
  }

  const { headers } = error as { headers?: unknown };
  return typeof headers === "object" && headers !== null ? (headers as Record<string, string>) : undefined;
}

/**
 * Recognizes the abort shapes this SDK actually emits. It normalizes fetch
 * aborts into `SonioxHttpError` with `code: "aborted"` and no status, and its
 * polling loop throws a bare `Error("Transcription wait aborted")`, so matching
 * only DOM-style `AbortError`/`ABORT_ERR` would never fire.
 */
function isAbortLike(error: unknown): boolean {
  return (
    readName(error) === "AbortError" ||
    readCode(error) === "ABORT_ERR" ||
    readCode(error) === "aborted" ||
    readMessage(error) === "Transcription wait aborted"
  );
}

function isTimeoutLike(error: unknown): boolean {
  return readName(error) === "TimeoutError" || readCode(error) === "timeout";
}

function readMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function readName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function readCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }

  const { statusCode } = error as { statusCode?: unknown };
  return typeof statusCode === "number" && Number.isInteger(statusCode) ? statusCode : undefined;
}

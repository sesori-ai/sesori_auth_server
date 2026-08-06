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
    audio_duration_ms: z.number().finite().nonnegative().nullish(),
    error_type: z.string().nullish(),
    error_message: z.string().nullish(),
  })
  .loose();

const transcriptSchema = z
  .object({
    text: z.string(),
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
  audioDurationMs: number | null;
};

function fail(reason: TranscriptionFailureReason, cause?: unknown): never {
  throw new TranscriptionFailure(reason, { cause });
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
 */
export function parseTranscription(value: unknown): ValidatedTranscription {
  const result = completedTranscriptionSchema.safeParse(value);
  if (!result.success) {
    fail(TranscriptionFailureReason.MalformedOutput, result.error.issues);
  }

  const { id, status, audio_duration_ms: audioDurationMs } = result.data;
  if (status === "error") {
    fail(TranscriptionFailureReason.ProviderRejected);
  }

  if (status !== "completed") {
    fail(TranscriptionFailureReason.Timeout);
  }

  return { id, status, audioDurationMs: audioDurationMs ?? null };
}

/** Validates a transcript payload and returns only its text. */
export function parseTranscriptText(value: unknown): string {
  const result = transcriptSchema.safeParse(value);
  if (!result.success) {
    fail(TranscriptionFailureReason.MalformedOutput, result.error.issues);
  }

  return result.data.text;
}

/**
 * Converts audio duration to whole seconds for the daily quota. Rounds up so a
 * partial second is never billed as zero, matching the OpenAI estimate policy.
 * A provider that omits duration is malformed output rather than a free request.
 */
export function toBillableSeconds(audioDurationMs: number | null): number {
  if (audioDurationMs === null) {
    fail(TranscriptionFailureReason.MalformedOutput);
  }

  return Math.ceil(audioDurationMs / 1000);
}

/**
 * Maps a thrown SDK value to a provider-neutral reason. Only stable, structural
 * signals are inspected; raw provider messages never escape this module.
 */
export function toFailureReason(error: unknown): TranscriptionFailureReason {
  if (error instanceof TranscriptionFailure) {
    return error.reason;
  }

  if (isAbortLike(error)) {
    return TranscriptionFailureReason.Cancelled;
  }

  if (isTimeoutLike(error)) {
    return TranscriptionFailureReason.Timeout;
  }

  const statusCode = readStatusCode(error);
  if (statusCode === undefined) {
    return TranscriptionFailureReason.Unavailable;
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

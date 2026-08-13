import { z } from "zod";
import { RealtimeTranscriptionFailure, RealtimeTranscriptionFailureReason } from "../types/transcription.js";
import type { RealtimeProviderEvent } from "../clients/realtime-transcription-client.js";

const maxTranscriptCharacters = 1_000_000;

const tokenSchema = z
  .object({
    text: z.string().max(maxTranscriptCharacters),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .refine((value) => Number.isFinite(value)),
    is_final: z.boolean(),
    start_ms: z
      .number()
      .min(0)
      .refine((value) => Number.isFinite(value))
      .optional(),
    end_ms: z
      .number()
      .min(0)
      .refine((value) => Number.isFinite(value))
      .optional(),
    speaker: z.string().optional(),
    language: z.string().optional(),
    translation_status: z.enum(["none", "original", "translation"]).optional(),
    source_language: z.string().optional(),
  })
  .strict();

const resultSchema = z
  .object({
    tokens: z.array(tokenSchema).max(10_000),
    final_audio_proc_ms: z
      .number()
      .min(0)
      .refine((value) => Number.isFinite(value)),
    total_audio_proc_ms: z
      .number()
      .min(0)
      .refine((value) => Number.isFinite(value)),
    finished: z.boolean().optional(),
  })
  .strict();

const errorPayloadSchema = z
  .object({
    error_code: z.number().int().positive(),
    error_message: z.string().optional(),
  })
  .strict();

const sdkErrorMetadataSchema = z
  .object({
    code: z.string().optional(),
    statusCode: z.number().int().optional(),
    name: z.string().optional(),
  })
  .strict();

function fail(reason: RealtimeTranscriptionFailureReason, cause?: unknown): never {
  throw new RealtimeTranscriptionFailure(reason, { cause });
}

export function parseSonioxRealtimeResult(value: unknown): RealtimeProviderEvent {
  const result = resultSchema.safeParse(value);
  if (!result.success) {
    fail(RealtimeTranscriptionFailureReason.MalformedOutput, result.error.issues);
  }

  if (result.data.finished === true) {
    return { type: "finished" };
  }

  const finalTextDelta = result.data.tokens
    .filter((token) => !isControlToken(token.text))
    .filter((token) => token.is_final)
    .map((token) => token.text)
    .join("");
  const provisionalText = result.data.tokens
    .filter((token) => !isControlToken(token.text))
    .filter((token) => !token.is_final)
    .map((token) => token.text)
    .join("");

  return {
    type: "transcript",
    confirmedDelta: finalTextDelta,
    provisional: provisionalText,
    finalAudioMs: result.data.final_audio_proc_ms,
    totalAudioMs: result.data.total_audio_proc_ms,
  };
}

export function parseSonioxRealtimeError(value: unknown): never {
  const result = errorPayloadSchema.safeParse(value);
  if (!result.success) {
    fail(RealtimeTranscriptionFailureReason.MalformedOutput, result.error.issues);
  }

  fail(reasonFromStatusCode(result.data.error_code));
}

export function toRealtimeFailureReason(error: unknown): RealtimeTranscriptionFailureReason {
  if (error instanceof RealtimeTranscriptionFailure) {
    return error.reason;
  }

  const metadata = parseSdkErrorMetadata(error);
  const code = metadata.code;
  if (code === "aborted") {
    return RealtimeTranscriptionFailureReason.Unavailable;
  }

  if (code === "auth_error") {
    return RealtimeTranscriptionFailureReason.Configuration;
  }

  if (code === "bad_request" || code === "state_error") {
    return RealtimeTranscriptionFailureReason.Internal;
  }

  if (code === "quota_exceeded") {
    return RealtimeTranscriptionFailureReason.Capacity;
  }

  const statusCode = metadata.statusCode;
  if (statusCode !== undefined) {
    return reasonFromStatusCode(statusCode);
  }

  const name = metadata.name;
  if (name === "AbortError") {
    return RealtimeTranscriptionFailureReason.Unavailable;
  }

  if (name === "TimeoutError") {
    return RealtimeTranscriptionFailureReason.Timeout;
  }

  return RealtimeTranscriptionFailureReason.Unavailable;
}

function parseSdkErrorMetadata(error: unknown): {
  readonly code?: string;
  readonly statusCode?: number;
  readonly name?: string;
} {
  const value =
    error instanceof Error
      ? {
          code: readUnknownProperty(error, "code"),
          statusCode: readUnknownProperty(error, "statusCode"),
          name: error.name,
        }
      : error;
  const result = sdkErrorMetadataSchema.safeParse(value);
  if (!result.success) {
    return {};
  }

  return result.data;
}

function isControlToken(text: string): boolean {
  return text === "<end>" || text === "<fin>";
}

function reasonFromStatusCode(statusCode: number): RealtimeTranscriptionFailureReason {
  if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
    return RealtimeTranscriptionFailureReason.Configuration;
  }

  if (statusCode === 402 || statusCode === 429) {
    return RealtimeTranscriptionFailureReason.Capacity;
  }

  if (statusCode === 400 || statusCode === 413 || statusCode === 415 || statusCode === 422) {
    return RealtimeTranscriptionFailureReason.Internal;
  }

  if (statusCode >= 500) {
    return RealtimeTranscriptionFailureReason.Unavailable;
  }

  return RealtimeTranscriptionFailureReason.Unavailable;
}

function readUnknownProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }

  return value[property as keyof typeof value];
}

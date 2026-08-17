import { z } from "zod";
import {
  RealtimeProviderEventType,
  RealtimeTranscriptionFailure,
  RealtimeTranscriptionFailureReason,
} from "../types/transcription.js";
import type { RealtimeProviderEvent } from "../clients/realtime-transcription-client.js";

const maxTranscriptCharacters = 1_000_000;
const maxPublicTranscriptCharacters = 32_768;

export type SonioxRealtimeParseOptions = {
  readonly maxAudioDurationMs: number;
};

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
    // `@soniox/node` returns the untrimmed provider payload as `raw` on every
    // result and spreads it into the emitted event, so rejecting it would fail
    // the first transcript of every session. It is declared here purely so
    // `.strict()` keeps rejecting genuinely unexpected provider fields, and is
    // never read: the returned event below is built from named fields only, so
    // the provider echo cannot reach a client, a log, or an error cause.
    raw: z.unknown().optional(),
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

export function parseSonioxRealtimeResult(value: unknown, options: SonioxRealtimeParseOptions): RealtimeProviderEvent {
  const result = resultSchema.safeParse(value);
  if (!result.success) {
    fail(RealtimeTranscriptionFailureReason.MalformedOutput, result.error.issues);
  }

  if (
    result.data.final_audio_proc_ms > options.maxAudioDurationMs ||
    result.data.total_audio_proc_ms > options.maxAudioDurationMs
  ) {
    fail(RealtimeTranscriptionFailureReason.MalformedOutput);
  }

  if (result.data.finished === true) {
    return { type: RealtimeProviderEventType.Finished };
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

  if (finalTextDelta.length > maxPublicTranscriptCharacters || provisionalText.length > maxPublicTranscriptCharacters) {
    fail(RealtimeTranscriptionFailureReason.MalformedOutput);
  }

  return {
    type: RealtimeProviderEventType.Transcript,
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

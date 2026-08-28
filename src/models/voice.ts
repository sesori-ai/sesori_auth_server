import { z } from "zod";
import { bridgeIdSchema } from "./bridge.js";
import {
  RealtimeAudioEncoding,
  RealtimeChannelCount,
  RealtimeClientMessageType,
  RealtimeFinishedReason,
  RealtimeProtocolErrorCode,
  RealtimeProtocolVersion,
  RealtimeSampleRate,
  RealtimeServerEventType,
} from "../types/transcription.js";

export const projectKeySchema = z
  .string()
  .regex(/^prj_v1_[A-Za-z0-9_-]{43}$/)
  .brand<"ProjectKey">();

export type ProjectKey = z.infer<typeof projectKeySchema>;

export enum ProjectGlossaryScopeType {
  repository = "repository",
  bridgeLocal = "bridge_local",
}

const repositoryProjectGlossaryScopeSchema = z
  .object({
    type: z.literal(ProjectGlossaryScopeType.repository),
    projectKey: projectKeySchema,
  })
  .strict();

const bridgeLocalProjectGlossaryScopeSchema = z
  .object({
    type: z.literal(ProjectGlossaryScopeType.bridgeLocal),
    projectKey: projectKeySchema,
    bridgeId: bridgeIdSchema,
  })
  .strict();

export const projectGlossaryScopeSchema = z.discriminatedUnion("type", [
  repositoryProjectGlossaryScopeSchema,
  bridgeLocalProjectGlossaryScopeSchema,
]);

export type ProjectGlossaryScope = z.infer<typeof projectGlossaryScopeSchema>;

export const glossaryWordSchema = z.string().trim().min(1).max(200);

export const glossaryWordsSchema = z.array(glossaryWordSchema).min(1).max(100);

export const glossaryAddBodySchema = z
  .object({
    scope: projectGlossaryScopeSchema,
    words: glossaryWordsSchema,
  })
  .strict();

export const glossaryRemoveBodySchema = z
  .object({
    scope: projectGlossaryScopeSchema,
    words: glossaryWordsSchema,
  })
  .strict();

export const glossaryListQuerySchema = z
  .object({
    projectKey: projectKeySchema,
  })
  .strict();

export const transcribeMultipartSchema = z
  .object({
    // COMPATIBILITY 2026-08-06 (v0.1.0): Apps at or before 1.6.1 omit projectKey from multipart transcription requests. Require it after every supported app sends project context.
    projectKey: projectKeySchema.optional(),
  })
  .strict();

const nonNegativeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .refine((value) => Number.isFinite(value));

/**
 * Protocol v1 outbound ceilings. Both are wire contract rather than tunables,
 * and they are deliberately expressed as one pair so they cannot drift apart:
 *
 * - `MAX_REALTIME_EVENT_BYTES` bounds the serialized JSON of any single server
 *   event, and is the budget the route enforces before writing to the socket.
 * - `MAX_REALTIME_TRANSCRIPT_CHARACTERS` bounds each public transcript field.
 *
 * The character bound alone does not imply the byte bound: two full fields, or
 * one full field in any script that costs more than two bytes per code point,
 * serialize past the byte budget. That gap used to be reachable — the provider
 * boundary admitted such a transcript and the emitter then rejected it, which
 * the session controller turned into an `internal_error` terminal. A valid
 * transcript must never be able to kill a session, so `boundRealtimeTranscript`
 * below spends the byte budget where the transcript is bounded, and every
 * later check is a backstop that cannot fire for a bounded transcript.
 */
export const MAX_REALTIME_EVENT_BYTES = 65_536;
export const MAX_REALTIME_TRANSCRIPT_CHARACTERS = 32_768;

export const REALTIME_PROTOCOL_ERROR_RETRYABLE = {
  [RealtimeProtocolErrorCode.InvalidMessage]: false,
  [RealtimeProtocolErrorCode.UnsupportedProtocol]: false,
  [RealtimeProtocolErrorCode.QuotaExhausted]: false,
  [RealtimeProtocolErrorCode.InvalidAudio]: false,
  [RealtimeProtocolErrorCode.ProviderRejected]: false,
  [RealtimeProtocolErrorCode.AudioTimeout]: true,
  [RealtimeProtocolErrorCode.ProviderTimeout]: true,
  [RealtimeProtocolErrorCode.InternalError]: true,
  [RealtimeProtocolErrorCode.StartTimeout]: true,
  [RealtimeProtocolErrorCode.ProviderCapacity]: true,
  [RealtimeProtocolErrorCode.ProviderUnavailable]: true,
  [RealtimeProtocolErrorCode.SlowClient]: true,
  [RealtimeProtocolErrorCode.ServiceRestarting]: true,
} as const satisfies Record<RealtimeProtocolErrorCode, boolean>;

export const realtimeAudioFormatSchema = z
  .object({
    encoding: z.enum(RealtimeAudioEncoding),
    sampleRate: z.enum(RealtimeSampleRate),
    channels: z.enum(RealtimeChannelCount),
  })
  .strict();

export const realtimeStartMessageSchema = z
  .object({
    type: z.literal(RealtimeClientMessageType.Start),
    protocolVersion: z.literal(RealtimeProtocolVersion.V1),
    projectKey: projectKeySchema.nullable(),
    audio: realtimeAudioFormatSchema,
  })
  .strict();

export const realtimeFinishMessageSchema = z.object({ type: z.literal(RealtimeClientMessageType.Finish) }).strict();

export const realtimeCancelMessageSchema = z.object({ type: z.literal(RealtimeClientMessageType.Cancel) }).strict();

export const realtimeClientMessageSchema = z.discriminatedUnion("type", [
  realtimeStartMessageSchema,
  realtimeFinishMessageSchema,
  realtimeCancelMessageSchema,
]);

export const realtimeReadyEventSchema = z
  .object({
    type: z.literal(RealtimeServerEventType.Ready),
    protocolVersion: z.literal(RealtimeProtocolVersion.V1),
    maxSessionSeconds: z.number().int().min(1).max(900),
    dailySecondsRemaining: nonNegativeIntegerSchema,
  })
  .strict();

export const realtimeTranscriptEventSchema = z
  .object({
    type: z.literal(RealtimeServerEventType.Transcript),
    confirmedDelta: z.string().max(MAX_REALTIME_TRANSCRIPT_CHARACTERS),
    provisional: z.string().max(MAX_REALTIME_TRANSCRIPT_CHARACTERS),
  })
  .strict()
  .refine((event) => event.confirmedDelta.length > 0 || event.provisional.length > 0);

export const realtimeCompleteEventSchema = z
  .object({
    type: z.literal(RealtimeServerEventType.Complete),
    reason: z.enum(RealtimeFinishedReason),
    dailySecondsRemaining: nonNegativeIntegerSchema,
  })
  .strict();

export const realtimeErrorEventSchema = z
  .object({
    type: z.literal(RealtimeServerEventType.Error),
    code: z.enum(RealtimeProtocolErrorCode),
    retryable: z.boolean(),
  })
  .strict()
  .refine((event) => REALTIME_PROTOCOL_ERROR_RETRYABLE[event.code] === event.retryable);

export const realtimeServerEventSchema = z.union([
  realtimeReadyEventSchema,
  realtimeTranscriptEventSchema,
  realtimeCompleteEventSchema,
  realtimeErrorEventSchema,
]);

/**
 * Exact serialized cost of a transcript event carrying two empty strings, so
 * the field budget below is derived rather than hand-counted. `JSON.stringify`
 * emits the same scaffolding regardless of field content, so the full event is
 * always this plus the escaped body of each field.
 */
const TRANSCRIPT_EVENT_SCAFFOLDING_BYTES = Buffer.byteLength(
  JSON.stringify({ type: RealtimeServerEventType.Transcript, confirmedDelta: "", provisional: "" }),
  "utf8",
);

/**
 * Bounds a provider transcript so the resulting public event is always
 * emittable: within the per-field character cap AND within the serialized byte
 * budget. Every provider adapter must route its transcript text through this
 * before returning it, exactly as each must reproduce the abort-is-not-a-
 * cancellation mapping — a provider boundary that bounds only characters
 * reintroduces the band where a legitimate transcript terminates the session.
 *
 * `confirmedDelta` is spent first because it is the only text a client never
 * sees again; `provisional` is superseded by the next result.
 */
export function boundRealtimeTranscript(input: { readonly confirmedDelta: string; readonly provisional: string }): {
  readonly confirmedDelta: string;
  readonly provisional: string;
} {
  const budgetBytes = MAX_REALTIME_EVENT_BYTES - TRANSCRIPT_EVENT_SCAFFOLDING_BYTES;
  const confirmed = boundToEscapedBytes(input.confirmedDelta, budgetBytes);
  const provisional = boundToEscapedBytes(input.provisional, budgetBytes - confirmed.bytes);
  return { confirmedDelta: confirmed.text, provisional: provisional.text };
}

/**
 * Longest code-point-aligned prefix that satisfies both the character cap and
 * `maxBytes` of escaped body, returned with its measured cost so a caller can
 * spend one shared budget across fields without re-measuring.
 */
function boundToEscapedBytes(text: string, maxBytes: number): { readonly text: string; readonly bytes: number } {
  const capped = sliceToCharacterCap(text, MAX_REALTIME_TRANSCRIPT_CHARACTERS);
  if (maxBytes <= 0) {
    return { text: "", bytes: 0 };
  }

  const cappedBytes = escapedByteLength(capped);
  if (cappedBytes <= maxBytes) {
    return { text: capped, bytes: cappedBytes };
  }

  const codePoints = Array.from(capped);
  let fitting = 0;
  let beyond = codePoints.length;
  while (fitting < beyond) {
    const candidate = Math.ceil((fitting + beyond) / 2);
    if (escapedByteLength(codePoints.slice(0, candidate).join("")) <= maxBytes) {
      fitting = candidate;
    } else {
      beyond = candidate - 1;
    }
  }

  const bounded = codePoints.slice(0, fitting).join("");
  return { text: bounded, bytes: escapedByteLength(bounded) };
}

/** Escaped body cost excluding the surrounding quotes, which the scaffolding already charges. */
function escapedByteLength(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

function sliceToCharacterCap(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text;
  }

  const sliced = text.slice(0, maxCharacters);
  const lastUnit = sliced.charCodeAt(sliced.length - 1);
  // The character cap counts UTF-16 units, so an exact slice can strand a high
  // surrogate whose pair was just cut. Drop it rather than emit a lone half.
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

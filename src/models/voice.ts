import { z } from "zod";
import {
  RealtimeAudioEncoding,
  RealtimeChannelCount,
  RealtimeFinishedReason,
  RealtimeProtocolErrorCode,
  RealtimeProtocolVersion,
  RealtimeSampleRate,
} from "../types/transcription.js";

export const projectKeySchema = z
  .string()
  .regex(/^prj_v1_[A-Za-z0-9_-]{43}$/)
  .brand<"ProjectKey">();

export type ProjectKey = z.infer<typeof projectKeySchema>;

export const glossaryWordSchema = z.string().trim().min(1).max(200);

export const glossaryWordsSchema = z.array(glossaryWordSchema).min(1).max(100);

export const glossaryAddBodySchema = z
  .object({
    projectKey: projectKeySchema,
    words: glossaryWordsSchema,
  })
  .strict();

export const glossaryRemoveBodySchema = glossaryAddBodySchema;

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
    type: z.literal("start"),
    protocolVersion: z.literal(RealtimeProtocolVersion.V1),
    projectKey: projectKeySchema.nullable(),
    audio: realtimeAudioFormatSchema,
  })
  .strict();

export const realtimeFinishMessageSchema = z.object({ type: z.literal("finish") }).strict();

export const realtimeCancelMessageSchema = z.object({ type: z.literal("cancel") }).strict();

export const realtimeClientMessageSchema = z.discriminatedUnion("type", [
  realtimeStartMessageSchema,
  realtimeFinishMessageSchema,
  realtimeCancelMessageSchema,
]);

export const realtimeReadyEventSchema = z
  .object({
    type: z.literal("ready"),
    protocolVersion: z.literal(RealtimeProtocolVersion.V1),
    maxSessionSeconds: z.number().int().min(1).max(900),
    dailySecondsRemaining: nonNegativeIntegerSchema,
  })
  .strict();

export const realtimeTranscriptEventSchema = z
  .object({
    type: z.literal("transcript"),
    confirmedDelta: z.string().max(32768),
    provisional: z.string().max(32768),
  })
  .strict()
  .refine((event) => event.confirmedDelta.length > 0 || event.provisional.length > 0);

export const realtimeCompleteEventSchema = z
  .object({
    type: z.literal("complete"),
    reason: z.enum(RealtimeFinishedReason),
    dailySecondsRemaining: nonNegativeIntegerSchema,
  })
  .strict();

export const realtimeErrorEventSchema = z
  .object({
    type: z.literal("error"),
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

export const realtimeProtocolFixtureSchema = z
  .object({
    valid: z.record(z.string(), z.unknown()),
    invalid: z.record(z.string(), z.unknown()),
  })
  .strict();

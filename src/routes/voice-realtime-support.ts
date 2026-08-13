import type { RawData, WebSocket } from "ws";
import type { z } from "zod";
import {
  REALTIME_PROTOCOL_ERROR_RETRYABLE,
  realtimeCancelMessageSchema,
  realtimeFinishMessageSchema,
  realtimeStartMessageSchema,
} from "../models/voice.js";
import { RealtimeProtocolErrorCode } from "../types/transcription.js";

export const FIRST_FRAME_TIMEOUT_MS = 5_000;
export const MAX_TEXT_BYTES = 2_048;
export const MAX_BINARY_BYTES = 65_536;
export const MAX_TRANSPORT_PAYLOAD_BYTES = MAX_BINARY_BYTES + 1;
export const SLOW_CLIENT_BUFFERED_BYTES = 256 * 1024;

export type RealtimeRoutePolicy = {
  readonly firstFrameTimeoutMs: number;
  readonly maxTextFrameBytes: number;
  readonly maxAudioFrameBytes: number;
  readonly outboundBufferMaxBytes: number;
};

export type RealtimeStartFrameResult =
  | { readonly kind: "valid"; readonly data: z.infer<typeof realtimeStartMessageSchema> }
  | { readonly kind: "invalid" }
  | { readonly kind: "unsupported" };

export type RealtimeControlFrameResult =
  | { readonly kind: "finish" }
  | { readonly kind: "cancel" }
  | { readonly kind: "invalid" };

export const DEFAULT_REALTIME_ROUTE_POLICY: RealtimeRoutePolicy = {
  firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
  maxTextFrameBytes: MAX_TEXT_BYTES,
  maxAudioFrameBytes: MAX_BINARY_BYTES,
  outboundBufferMaxBytes: SLOW_CLIENT_BUFFERED_BYTES,
};

export const CLOSE_CODE = {
  normal: 1000,
  policy: 1008,
  unavailable: 1013,
  internal: 1011,
} as const;

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function sendTerminalError(
  socket: WebSocket,
  code: RealtimeProtocolErrorCode,
  policy: RealtimeRoutePolicy,
): boolean {
  return sendEvent(socket, { type: "error", code, retryable: REALTIME_PROTOCOL_ERROR_RETRYABLE[code] }, policy);
}

export function sendEvent(socket: WebSocket, event: object, policy: RealtimeRoutePolicy): boolean {
  if (socket.bufferedAmount > policy.outboundBufferMaxBytes) {
    sendSlowClientError(socket);
    return false;
  }

  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") > policy.maxAudioFrameBytes) {
    sendSlowClientError(socket);
    return false;
  }

  socket.send(serialized);
  return true;
}

function sendSlowClientError(socket: WebSocket): void {
  const serialized = JSON.stringify({
    type: "error",
    code: RealtimeProtocolErrorCode.SlowClient,
    retryable: REALTIME_PROTOCOL_ERROR_RETRYABLE[RealtimeProtocolErrorCode.SlowClient],
  });
  if (socket.bufferedAmount === 0) {
    socket.send(serialized);
  }
  socket.close(CLOSE_CODE.unavailable);
}

export function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data));
}

export function decodeUtf8(buffer: Buffer): { readonly ok: true; readonly text: string } | { readonly ok: false } {
  try {
    return { ok: true, text: fatalUtf8Decoder.decode(buffer) };
  } catch (error) {
    if (error instanceof TypeError) {
      return { ok: false };
    }
    throw error;
  }
}

export function parseJson(source: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false };
    }
    throw error;
  }
}

export function parseStartFrame(data: RawData, policy: RealtimeRoutePolicy): RealtimeStartFrameResult {
  const raw = rawDataToBuffer(data);
  if (raw.byteLength > policy.maxTextFrameBytes) {
    return { kind: "invalid" };
  }

  const decoded = decodeUtf8(raw);
  const parsedJson = decoded.ok ? parseJson(decoded.text) : { ok: false as const };
  if (isUnsupportedStartProtocol(parsedJson)) {
    return { kind: "unsupported" };
  }

  const startResult = parsedJson.ok ? realtimeStartMessageSchema.safeParse(parsedJson.value) : null;
  if (startResult === null || !startResult.success) {
    return { kind: "invalid" };
  }

  return { kind: "valid", data: startResult.data };
}

export function parseControlFrame(data: RawData, policy: RealtimeRoutePolicy): RealtimeControlFrameResult {
  const raw = rawDataToBuffer(data);
  if (raw.byteLength > policy.maxTextFrameBytes) {
    return { kind: "invalid" };
  }

  const decoded = decodeUtf8(raw);
  const parsedJson = decoded.ok ? parseJson(decoded.text) : { ok: false as const };
  if (parsedJson.ok && realtimeFinishMessageSchema.safeParse(parsedJson.value).success) {
    return { kind: "finish" };
  }

  if (parsedJson.ok && realtimeCancelMessageSchema.safeParse(parsedJson.value).success) {
    return { kind: "cancel" };
  }

  return { kind: "invalid" };
}

function isUnsupportedStartProtocol(
  parsedJson: { readonly ok: true; readonly value: unknown } | { readonly ok: false },
): boolean {
  if (!parsedJson.ok || typeof parsedJson.value !== "object" || parsedJson.value === null) {
    return false;
  }

  return (
    "type" in parsedJson.value &&
    parsedJson.value.type === "start" &&
    "protocolVersion" in parsedJson.value &&
    parsedJson.value.protocolVersion !== 1
  );
}

export function closeCodeForError(code: RealtimeProtocolErrorCode): number {
  switch (code) {
    case RealtimeProtocolErrorCode.ProviderRejected:
    case RealtimeProtocolErrorCode.AudioTimeout:
    case RealtimeProtocolErrorCode.ProviderTimeout:
    case RealtimeProtocolErrorCode.InternalError:
      return CLOSE_CODE.internal;
    case RealtimeProtocolErrorCode.ProviderUnavailable:
    case RealtimeProtocolErrorCode.ProviderCapacity:
    case RealtimeProtocolErrorCode.SlowClient:
    case RealtimeProtocolErrorCode.StartTimeout:
    case RealtimeProtocolErrorCode.ServiceRestarting:
      return CLOSE_CODE.unavailable;
    case RealtimeProtocolErrorCode.InvalidMessage:
    case RealtimeProtocolErrorCode.UnsupportedProtocol:
    case RealtimeProtocolErrorCode.InvalidAudio:
    case RealtimeProtocolErrorCode.QuotaExhausted:
      return CLOSE_CODE.policy;
    default:
      return assertNeverCode(code);
  }
}

export function closeSocket(socket: WebSocket, code: number): void {
  if (socket.readyState === socket.OPEN) {
    socket.close(code);
  }
}

function assertNeverCode(_code: never): never {
  throw new Error("unhandled realtime error code");
}

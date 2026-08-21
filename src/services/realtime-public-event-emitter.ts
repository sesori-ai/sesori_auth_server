import { REALTIME_PROTOCOL_ERROR_RETRYABLE } from "../models/voice.js";
import {
  RealtimeFinishedReason,
  RealtimeProtocolErrorCode,
  RealtimeProtocolVersion,
  RealtimeServerEventType,
} from "../types/transcription.js";
import {
  isPublicEventValid,
  type RealtimeErrorEvent,
  type RealtimeReadyEvent,
  type RealtimeSessionCallbacks,
  type RealtimeTranscriptEvent,
} from "./realtime-transcription-events.js";

export type PublicTerminalDecision =
  | { readonly kind: "complete"; readonly reason: RealtimeFinishedReason }
  | { readonly kind: "silent" }
  | { readonly kind: "error"; readonly code: RealtimeProtocolErrorCode };

export function emitReadyEvent(input: {
  readonly callbacks: RealtimeSessionCallbacks;
  readonly maxSessionSeconds: number;
  readonly dailySecondsRemaining: number;
}): boolean {
  const event: RealtimeReadyEvent = {
    type: RealtimeServerEventType.Ready,
    protocolVersion: RealtimeProtocolVersion.V1,
    maxSessionSeconds: input.maxSessionSeconds,
    dailySecondsRemaining: input.dailySecondsRemaining,
  };
  if (!isPublicEventValid(event)) {
    return false;
  }
  input.callbacks.onReady(event);
  return true;
}

export function emitTranscriptEvent(input: {
  readonly callbacks: RealtimeSessionCallbacks;
  readonly confirmedDelta: string;
  readonly provisional: string;
}): boolean {
  const event: RealtimeTranscriptEvent = {
    type: RealtimeServerEventType.Transcript,
    confirmedDelta: input.confirmedDelta,
    provisional: input.provisional,
  };
  if (!isPublicEventValid(event)) {
    return false;
  }
  input.callbacks.onTranscript(event);
  return true;
}

export function emitTerminalEvent(input: {
  readonly callbacks: RealtimeSessionCallbacks;
  readonly decision: PublicTerminalDecision;
  readonly remaining: number;
}): void {
  switch (input.decision.kind) {
    case "complete":
      emitCompleteOrInternalError(input.callbacks, {
        type: RealtimeServerEventType.Complete,
        reason: input.decision.reason,
        dailySecondsRemaining: input.remaining,
      });
      break;
    case "error":
      emitErrorOrInternalError(input.callbacks, input.decision.code);
      break;
    case "silent":
      break;
    default:
      assertNeverTerminalDecision(input.decision);
  }
}

function emitCompleteOrInternalError(
  callbacks: RealtimeSessionCallbacks,
  event: Parameters<RealtimeSessionCallbacks["onComplete"]>[0],
): void {
  if (isPublicEventValid(event)) {
    callbacks.onComplete(event);
    return;
  }

  emitInternalError(callbacks);
}

function emitErrorOrInternalError(callbacks: RealtimeSessionCallbacks, code: RealtimeProtocolErrorCode): void {
  const event: RealtimeErrorEvent = {
    type: RealtimeServerEventType.Error,
    code,
    retryable: REALTIME_PROTOCOL_ERROR_RETRYABLE[code],
  };
  if (isPublicEventValid(event)) {
    callbacks.onError(event);
    return;
  }

  emitInternalError(callbacks);
}

function emitInternalError(callbacks: RealtimeSessionCallbacks): void {
  const event: RealtimeErrorEvent = {
    type: RealtimeServerEventType.Error,
    code: RealtimeProtocolErrorCode.InternalError,
    retryable: REALTIME_PROTOCOL_ERROR_RETRYABLE[RealtimeProtocolErrorCode.InternalError],
  };
  callbacks.onError(event);
}

function assertNeverTerminalDecision(_decision: never): never {
  throw new Error("unhandled realtime terminal decision");
}

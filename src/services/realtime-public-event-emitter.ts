import { REALTIME_PROTOCOL_ERROR_RETRYABLE } from "../models/voice.js";
import { RealtimeFinishedReason, RealtimeProtocolErrorCode, RealtimeProtocolVersion } from "../types/transcription.js";
import { isPublicEventValid, type RealtimeSessionCallbacks } from "./realtime-transcription-events.js";

export type PublicTerminalDecision =
  | { readonly kind: "complete"; readonly reason: RealtimeFinishedReason }
  | { readonly kind: "silent" }
  | { readonly kind: "error"; readonly code: RealtimeProtocolErrorCode };

export function emitReadyEvent(input: {
  readonly callbacks: RealtimeSessionCallbacks;
  readonly maxSessionSeconds: number;
  readonly dailySecondsRemaining: number;
}): boolean {
  const event = {
    type: "ready" as const,
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
  const event = { type: "transcript" as const, confirmedDelta: input.confirmedDelta, provisional: input.provisional };
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
      input.callbacks.onComplete({
        type: "complete",
        reason: input.decision.reason,
        dailySecondsRemaining: input.remaining,
      });
      break;
    case "error":
      input.callbacks.onError({
        type: "error",
        code: input.decision.code,
        retryable: REALTIME_PROTOCOL_ERROR_RETRYABLE[input.decision.code],
      });
      break;
    case "silent":
      break;
    default:
      assertNeverTerminalDecision(input.decision);
  }
}

function assertNeverTerminalDecision(_decision: never): never {
  throw new Error("unhandled realtime terminal decision");
}

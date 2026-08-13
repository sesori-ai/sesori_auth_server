import {
  realtimeCompleteEventSchema,
  realtimeErrorEventSchema,
  realtimeReadyEventSchema,
  realtimeTranscriptEventSchema,
} from "../models/voice.js";
import { RealtimeFinishedReason, RealtimeProtocolErrorCode } from "../types/transcription.js";

export type RealtimeReadyEvent = {
  readonly type: "ready";
  readonly protocolVersion: 1;
  readonly maxSessionSeconds: number;
  readonly dailySecondsRemaining: number;
};

export type RealtimeTranscriptEvent = {
  readonly type: "transcript";
  readonly confirmedDelta: string;
  readonly provisional: string;
};

export type RealtimeCompleteEvent = {
  readonly type: "complete";
  readonly reason: RealtimeFinishedReason;
  readonly dailySecondsRemaining: number;
};

export type RealtimeErrorEvent = {
  readonly type: "error";
  readonly code: RealtimeProtocolErrorCode;
  readonly retryable: boolean;
};

export type RealtimeSessionCallbacks = {
  readonly onReady: (event: RealtimeReadyEvent) => void;
  readonly onTranscript: (event: RealtimeTranscriptEvent) => void;
  readonly onComplete: (event: RealtimeCompleteEvent) => void;
  readonly onError: (event: RealtimeErrorEvent) => void;
};

export function isPublicEventValid(
  event: RealtimeReadyEvent | RealtimeTranscriptEvent | RealtimeCompleteEvent | RealtimeErrorEvent,
): boolean {
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > 65_536) {
    return false;
  }

  switch (event.type) {
    case "ready":
      return realtimeReadyEventSchema.safeParse(event).success;
    case "transcript":
      return realtimeTranscriptEventSchema.safeParse(event).success;
    case "complete":
      return realtimeCompleteEventSchema.safeParse(event).success;
    case "error":
      return realtimeErrorEventSchema.safeParse({ type: event.type, code: event.code, retryable: event.retryable })
        .success;
    default:
      return assertNeverEvent(event);
  }
}

function assertNeverEvent(event: never): never {
  throw new Error(`unhandled realtime event ${JSON.stringify(event)}`);
}

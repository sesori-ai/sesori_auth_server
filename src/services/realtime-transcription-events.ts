import {
  realtimeCompleteEventSchema,
  realtimeErrorEventSchema,
  realtimeReadyEventSchema,
  realtimeTranscriptEventSchema,
} from "../models/voice.js";
import { RealtimeFinishedReason, RealtimeProtocolErrorCode, RealtimeServerEventType } from "../types/transcription.js";

export type RealtimeReadyEvent = {
  readonly type: RealtimeServerEventType.Ready;
  readonly protocolVersion: 1;
  readonly maxSessionSeconds: number;
  readonly dailySecondsRemaining: number;
};

export type RealtimeTranscriptEvent = {
  readonly type: RealtimeServerEventType.Transcript;
  readonly confirmedDelta: string;
  readonly provisional: string;
};

export type RealtimeCompleteEvent = {
  readonly type: RealtimeServerEventType.Complete;
  readonly reason: RealtimeFinishedReason;
  readonly dailySecondsRemaining: number;
};

export type RealtimeErrorEvent = {
  readonly type: RealtimeServerEventType.Error;
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
    case RealtimeServerEventType.Ready:
      return realtimeReadyEventSchema.safeParse(event).success;
    case RealtimeServerEventType.Transcript:
      return realtimeTranscriptEventSchema.safeParse(event).success;
    case RealtimeServerEventType.Complete:
      return realtimeCompleteEventSchema.safeParse(event).success;
    case RealtimeServerEventType.Error:
      return realtimeErrorEventSchema.safeParse(event).success;
    default:
      return assertNeverEvent(event);
  }
}

function assertNeverEvent(event: never): never {
  throw new Error(`unhandled realtime event ${JSON.stringify(event)}`);
}

import {
  MAX_REALTIME_EVENT_BYTES,
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
  // Backstop only. Transcripts are bounded against this same budget at the
  // provider boundary (`boundRealtimeTranscript`), so a legitimate transcript
  // can no longer fail here and be turned into an `internal_error` terminal.
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_REALTIME_EVENT_BYTES) {
    return false;
  }

  // Widened before narrowing so the exhaustiveness guard can report which type
  // it did not handle without serializing the event itself — the union carries
  // transcript text, which must never reach an Error message or a log.
  const eventType: string = event.type;

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
      return assertNeverEvent(event, eventType);
  }
}

function assertNeverEvent(_event: never, eventType: string): never {
  throw new Error(`unhandled realtime event type ${eventType}`);
}

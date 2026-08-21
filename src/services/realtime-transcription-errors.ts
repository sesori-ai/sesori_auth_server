import { REALTIME_PROTOCOL_ERROR_RETRYABLE } from "../models/voice.js";
import {
  RealtimeProtocolErrorCode,
  RealtimeTranscriptionFailure,
  RealtimeTranscriptionFailureReason,
} from "../types/transcription.js";

export class RealtimeAdmissionError extends Error {
  readonly code: RealtimeProtocolErrorCode;
  readonly retryable: boolean;

  constructor(code: RealtimeProtocolErrorCode) {
    super(code);
    this.name = "RealtimeAdmissionError";
    this.code = code;
    this.retryable = REALTIME_PROTOCOL_ERROR_RETRYABLE[code];
  }
}

export function toProviderErrorCode(error: unknown): RealtimeProtocolErrorCode {
  if (!(error instanceof RealtimeTranscriptionFailure)) {
    return RealtimeProtocolErrorCode.ProviderUnavailable;
  }

  switch (error.reason) {
    case RealtimeTranscriptionFailureReason.Capacity:
      return RealtimeProtocolErrorCode.ProviderCapacity;
    case RealtimeTranscriptionFailureReason.Timeout:
      return RealtimeProtocolErrorCode.ProviderTimeout;
    case RealtimeTranscriptionFailureReason.Configuration:
      return RealtimeProtocolErrorCode.ProviderRejected;
    case RealtimeTranscriptionFailureReason.MalformedOutput:
    case RealtimeTranscriptionFailureReason.Internal:
      return RealtimeProtocolErrorCode.InternalError;
    case RealtimeTranscriptionFailureReason.Cancelled:
      return RealtimeProtocolErrorCode.ServiceRestarting;
    case RealtimeTranscriptionFailureReason.Unavailable:
      return RealtimeProtocolErrorCode.ProviderUnavailable;
    default:
      return assertNeverRealtimeFailureReason(error.reason);
  }
}

function assertNeverRealtimeFailureReason(_reason: never): never {
  throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.InternalError);
}

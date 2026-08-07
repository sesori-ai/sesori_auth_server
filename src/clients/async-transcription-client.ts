import type { TranscriptionRequest, TranscriptionResult } from "../types/transcription.js";

/**
 * The provider-neutral async transcription boundary. Implementations own all
 * external SDK contact; they expose no provider job/file ID or provider error
 * type, and they throw only `TranscriptionFailure`.
 */
export interface AsyncTranscriptionClient {
  /**
   * Transcribes one bounded async audio request.
   *
   * `request.signal` is caller-owned cancellation. An implementation must
   * decide `Cancelled` from that signal and `Timeout` from its own budget,
   * rather than from a provider error shape, because SDKs report both as an
   * indistinguishable abort.
   *
   * Resolves with non-empty text and a positive whole `durationSeconds`, rounded
   * up so a sub-second clip is never billed as free. An absent or absurd
   * provider duration is `MalformedOutput`, never a free request.
   *
   * Rejects only with `TranscriptionFailure`. Retryability is not signalled
   * here: the service derives it from `TranscriptionFailureReason`, so
   * implementations classify the reason and never decide HTTP semantics.
   */
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

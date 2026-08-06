import type { TranscriptionRequest, TranscriptionResult } from "../types/transcription.js";

/**
 * The provider-neutral async transcription boundary. Implementations own all
 * external SDK contact; they expose no provider job/file ID or provider error
 * type, and they throw only `TranscriptionFailure`.
 */
export interface AsyncTranscriptionClient {
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

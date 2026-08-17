import type { RealtimeAudioFormat, RealtimeProviderEvent } from "../types/transcription.js";

export type RealtimeConnectRequest = {
  readonly audio: RealtimeAudioFormat;
  readonly terms: readonly string[];
  readonly maxAudioDurationMs: number;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: RealtimeProviderEvent) => void;
};

export interface RealtimeTranscriptionSession {
  readonly closed: Promise<void>;
  sendAudio(data: Buffer): void;
  finish(): Promise<void>;
  cancel(): void;
  close(): void;
}

export interface RealtimeTranscriptionClient {
  connect(request: RealtimeConnectRequest): Promise<RealtimeTranscriptionSession>;
}

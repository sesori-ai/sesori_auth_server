import { RealtimeProviderEventType, type RealtimeAudioFormat } from "../types/transcription.js";

export type RealtimeProviderEvent =
  | {
      readonly type: RealtimeProviderEventType.Transcript;
      readonly confirmedDelta: string;
      readonly provisional: string;
      readonly finalAudioMs: number;
      readonly totalAudioMs: number;
    }
  | { readonly type: RealtimeProviderEventType.Finished };

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

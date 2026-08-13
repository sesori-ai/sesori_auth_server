import type { ProjectKey } from "../models/voice.js";
import type { RealtimeAudioFormat, RealtimeFinishedReason } from "../types/transcription.js";
import type { RealtimeSessionCallbacks } from "./realtime-transcription-events.js";

export type RealtimeTranscriptionPolicy = {
  readonly dailyLimitSeconds: number;
  readonly maxSessionSeconds: number;
  readonly firstAudioTimeoutMs: number;
  readonly finishTimeoutMs: number;
  readonly disposeTimeoutMs: number;
};

export type RealtimeStartRequest = {
  readonly userId: string;
  readonly projectKey: ProjectKey | null;
  readonly audio: RealtimeAudioFormat;
  readonly callbacks: RealtimeSessionCallbacks;
  readonly signal: AbortSignal;
};

export type RealtimeTranscriptionSession = {
  readonly closed: Promise<void>;
  readonly readyLimitReason: RealtimeFinishedReason;
  sendAudio(data: Buffer): void;
  finish(): Promise<void>;
  cancel(): Promise<void>;
  disconnect(): Promise<void>;
  shutdown(): Promise<void>;
};

export type RealtimeSessionOwner = {
  release(session: RealtimeTranscriptionSession): void;
  recordUsage(args: {
    readonly userId: string;
    readonly seconds: number;
    readonly remainingAtAdmission: number;
  }): Promise<number>;
};

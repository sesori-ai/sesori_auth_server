import type { ProjectKey } from "../models/voice.js";
import type { RealtimeAudioFormat, RealtimeFinishedReason } from "../types/transcription.js";
import type { RealtimeSessionCallbacks } from "./realtime-transcription-events.js";

export type RealtimeTranscriptionPolicy = {
  readonly dailyLimitSeconds: number;
  readonly maxSessionSeconds: number;
  /**
   * Deadline for the first audio frame, rearmed on every accepted frame. A session that stops
   * sending audio therefore terminates after this much silence instead of holding its client
   * socket, provider socket, and timers until the wall-clock session cap.
   */
  readonly firstAudioTimeoutMs: number;
  readonly finishTimeoutMs: number;
  readonly disposeTimeoutMs: number;
  /** Concurrent admitted sessions allowed per user, counting sessions still resolving `start`. */
  readonly maxConcurrentSessionsPerUser: number;
  /** Concurrent admitted sessions allowed for the whole process. */
  readonly maxConcurrentSessions: number;
  /**
   * How far ahead of real time a client may deliver audio. Live capture produces one second of
   * audio per second of elapsed session time regardless of network jitter, so this only has to
   * absorb clock skew and audio buffered between `start` and `ready`.
   */
  readonly audioPaceBurstSeconds: number;
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

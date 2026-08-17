/**
 * Provider-neutral transcription domain types. Nothing here names a provider,
 * so services and routes stay independent of which client is configured.
 */

/** Closed set of transcription failures a provider client may report. */
export enum TranscriptionFailureReason {
  InvalidInput = "invalid_input",
  Capacity = "capacity",
  Unavailable = "unavailable",
  Timeout = "timeout",
  ProviderRejected = "provider_rejected",
  MalformedOutput = "malformed_output",
  Cancelled = "cancelled",
  Internal = "internal",
}

/** Deploy-time async provider selection. Single source for the config schema and the composition-root branch. */
export enum AsyncTranscriptionProvider {
  OpenAI = "openai",
  Soniox = "soniox",
}

export enum RealtimeProtocolVersion {
  V1 = 1,
}

export enum RealtimeAudioEncoding {
  PcmS16Le = "pcm_s16le",
}

export enum RealtimeSampleRate {
  Rate16000 = 16000,
  Rate24000 = 24000,
  Rate44100 = 44100,
  Rate48000 = 48000,
}

export enum RealtimeChannelCount {
  Mono = 1,
}

export enum RealtimeFinishedReason {
  Finished = "finished",
  SessionLimit = "session_limit",
  QuotaLimit = "quota_limit",
}

export enum RealtimeProtocolErrorCode {
  StartTimeout = "start_timeout",
  InvalidMessage = "invalid_message",
  UnsupportedProtocol = "unsupported_protocol",
  InvalidAudio = "invalid_audio",
  ProviderRejected = "provider_rejected",
  AudioTimeout = "audio_timeout",
  ProviderTimeout = "provider_timeout",
  InternalError = "internal_error",
  ProviderCapacity = "provider_capacity",
  QuotaExhausted = "quota_exhausted",
  ProviderUnavailable = "provider_unavailable",
  SlowClient = "slow_client",
  ServiceRestarting = "service_restarting",
}

export enum RealtimeClientMessageType {
  Start = "start",
  Finish = "finish",
  Cancel = "cancel",
}

export enum RealtimeServerEventType {
  Ready = "ready",
  Transcript = "transcript",
  Complete = "complete",
  Error = "error",
}

export enum RealtimeProviderEventType {
  Transcript = "transcript",
  Finished = "finished",
}

export enum RealtimeTranscriptionFailureReason {
  Capacity = "capacity",
  Unavailable = "unavailable",
  Timeout = "timeout",
  Configuration = "configuration",
  MalformedOutput = "malformed_output",
  Cancelled = "cancelled",
  Internal = "internal",
}

export type RealtimeAudioFormat = {
  readonly encoding: RealtimeAudioEncoding;
  readonly sampleRate: RealtimeSampleRate;
  readonly channels: RealtimeChannelCount;
};

/**
 * Provider-neutral realtime event, produced by an API boundary and consumed by
 * the client and session layers. It lives here rather than beside the client
 * interface so `src/api/` — which must not depend on `src/clients/` — can name
 * the shape it returns, matching the async adapter's direction of dependency.
 */
export type RealtimeProviderEvent =
  | {
      readonly type: RealtimeProviderEventType.Transcript;
      readonly confirmedDelta: string;
      readonly provisional: string;
      readonly finalAudioMs: number;
      readonly totalAudioMs: number;
    }
  | { readonly type: RealtimeProviderEventType.Finished };

export class RealtimeTranscriptionFailure extends Error {
  readonly reason: RealtimeTranscriptionFailureReason;

  constructor(reason: RealtimeTranscriptionFailureReason, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = "RealtimeTranscriptionFailure";
    this.reason = reason;
  }
}

/** Explicit regional REST endpoints. Resolved locally so SDK environment precedence can never redirect audio or credentials. */
export const SONIOX_REST_URL_BY_REGION = {
  eu: "https://api.eu.soniox.com",
} as const satisfies Record<string, string>;

/**
 * Explicit regional realtime WebSocket endpoints, for the same reason as the
 * REST table above: passed as `realtime.ws_base_url`, they outrank the SDK's
 * `SONIOX_WS_URL` environment fallback and the `SONIOX_BASE_DOMAIN`-derived
 * default. Leaving the realtime endpoint to `region` alone would let an
 * environment variable stream audio and the API key to another host.
 */
export const SONIOX_REALTIME_WS_URL_BY_REGION = {
  eu: "wss://stt-rt.eu.soniox.com/transcribe-websocket",
} as const satisfies Record<string, string>;

/**
 * The single glossary-prompt format. Shared so the budget reserved by
 * `GlossaryService` and the string rendered by a provider adapter cannot drift.
 */
export const TRANSCRIPTION_PROMPT_PREFIX = "The following terms may appear in the audio: ";
export const TRANSCRIPTION_PROMPT_SUFFIX = ".";

export function renderTranscriptionPrompt(terms: string[]): string | null {
  if (terms.length === 0) {
    return null;
  }

  return `${TRANSCRIPTION_PROMPT_PREFIX}${terms.join(", ")}${TRANSCRIPTION_PROMPT_SUFFIX}`;
}

export type TranscriptionRequest = {
  audio: Buffer;
  filename: string;
  mimeType: string;
  /** Glossary context for this project, already trimmed and bounded. */
  terms: string[];
  signal?: AbortSignal;
};

export type TranscriptionResult = {
  text: string;
  durationSeconds: number;
};

/**
 * The single failure type provider clients throw. The original error is kept
 * only as `cause` for local debugging and is never surfaced to a client.
 */
export class TranscriptionFailure extends Error {
  readonly reason: TranscriptionFailureReason;
  /**
   * Cooldown in whole seconds that the provider itself asked for, when it
   * stated one (a `Retry-After` on a 429). Advisory and untrusted: the API
   * error layer clamps it before it can reach a response header. Absent means
   * "no provider guidance", not "retry immediately".
   */
  readonly retryAfterSeconds?: number;

  constructor(reason: TranscriptionFailureReason, options?: { cause?: unknown; retryAfterSeconds?: number }) {
    super(reason, options);
    this.name = "TranscriptionFailure";
    this.reason = reason;

    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

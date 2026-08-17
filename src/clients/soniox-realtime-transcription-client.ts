import {
  parseSonioxRealtimeError,
  parseSonioxRealtimeResult,
  toRealtimeFailureReason,
} from "../api/soniox-realtime-api.js";
import { RealtimeAudioEncoding, RealtimeProviderEventType } from "../types/transcription.js";
import type {
  RealtimeConnectRequest,
  RealtimeProviderEvent,
  RealtimeTranscriptionClient,
  RealtimeTranscriptionSession,
} from "./realtime-transcription-client.js";
import { RealtimeTranscriptionFailure, RealtimeTranscriptionFailureReason } from "../types/transcription.js";

export type SonioxRealtimeSdkSession = {
  connect(): Promise<void>;
  sendAudio(data: Buffer | Uint8Array | ArrayBuffer): void;
  finish(): Promise<void>;
  close(): void;
  on(event: "result", handler: (result: unknown) => void): SonioxRealtimeSdkSession;
  on(event: "error", handler: (error: unknown) => void): SonioxRealtimeSdkSession;
  on(event: "finished", handler: () => void): SonioxRealtimeSdkSession;
  off(event: "result", handler: (result: unknown) => void): SonioxRealtimeSdkSession;
  off(event: "error", handler: (error: unknown) => void): SonioxRealtimeSdkSession;
  off(event: "finished", handler: () => void): SonioxRealtimeSdkSession;
};

export type SonioxRealtimeSdk = {
  readonly realtime: {
    stt(config: SonioxRealtimeConfig, options: SonioxRealtimeSessionOptions): SonioxRealtimeSdkSession;
  };
};

type SonioxRealtimeConfig = {
  readonly model: string;
  readonly audio_format: RealtimeAudioEncoding;
  readonly sample_rate: number;
  readonly num_channels: number;
  readonly language_hints: string[];
  readonly language_hints_strict: boolean;
  readonly enable_endpoint_detection: boolean;
  readonly enable_language_identification: boolean;
  readonly enable_speaker_diarization: boolean;
  readonly context?: { readonly terms: string[] };
};

type SonioxRealtimeSessionOptions = {
  /**
   * The caller's cancellation only, and optional because a caller need not
   * supply one. Never a timeout signal: the SDK registers this for the whole
   * session and tears the session down when it aborts.
   */
  readonly signal: AbortSignal | undefined;
  readonly connect_timeout_ms: number;
};

export class SonioxRealtimeClient implements RealtimeTranscriptionClient {
  readonly #sdk: SonioxRealtimeSdk;
  readonly #model: string;
  readonly #connectTimeoutMs: number;

  constructor(deps: { readonly sdk: SonioxRealtimeSdk; readonly model: string; readonly connectTimeoutMs: number }) {
    this.#sdk = deps.sdk;
    this.#model = deps.model;
    this.#connectTimeoutMs = deps.connectTimeoutMs;
  }

  async connect(request: RealtimeConnectRequest): Promise<RealtimeTranscriptionSession> {
    if (isSignalAborted(request.signal)) {
      throw new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.Cancelled);
    }

    const timeoutSignal = AbortSignal.timeout(this.#connectTimeoutMs);
    const sdkSession = this.#sdk.realtime.stt(this.#toConfig(request), {
      // Only the caller's cancellation may live for the session's lifetime. The
      // SDK keeps this signal registered for the whole session and tears the
      // session down when it aborts, and `AbortSignal.timeout` cannot be
      // cancelled — folding the connect deadline in here would abort every
      // session `connectTimeoutMs` after it started, making the session cap,
      // the wall clock, and the byte cap all unreachable. The connect deadline
      // is enforced by `connect_timeout_ms` and the `waitForConnect` race below.
      signal: request.signal,
      connect_timeout_ms: this.#connectTimeoutMs,
    });
    const session = new SonioxRealtimeSessionAdapter(sdkSession, request.onEvent, request.maxAudioDurationMs);

    try {
      await waitForConnect(sdkSession.connect(), timeoutSignal, this.#connectTimeoutMs);
      return session;
    } catch (error) {
      session.close();
      if (isSignalAborted(request.signal)) {
        throw new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.Cancelled, { cause: error });
      }

      if (timeoutSignal.aborted) {
        throw new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.Timeout, { cause: error });
      }

      throw new RealtimeTranscriptionFailure(toRealtimeFailureReason(error), { cause: error });
    }
  }

  #toConfig(request: RealtimeConnectRequest): SonioxRealtimeConfig {
    return {
      model: this.#model,
      audio_format: request.audio.encoding,
      sample_rate: request.audio.sampleRate,
      num_channels: request.audio.channels,
      language_hints: ["en"],
      language_hints_strict: false,
      enable_endpoint_detection: false,
      enable_language_identification: false,
      enable_speaker_diarization: false,
      ...(request.terms.length > 0 ? { context: { terms: [...request.terms] } } : {}),
    };
  }
}

class SonioxRealtimeSessionAdapter implements RealtimeTranscriptionSession {
  readonly #sdkSession: SonioxRealtimeSdkSession;
  readonly #onEvent: (event: RealtimeProviderEvent) => void;
  readonly #maxAudioDurationMs: number;
  readonly #closedController = new Deferred<void>();
  #closed = false;
  #settled = false;

  constructor(
    sdkSession: SonioxRealtimeSdkSession,
    onEvent: (event: RealtimeProviderEvent) => void,
    maxAudioDurationMs: number,
  ) {
    this.#sdkSession = sdkSession;
    this.#onEvent = onEvent;
    this.#maxAudioDurationMs = maxAudioDurationMs;
    this.#sdkSession.on("result", this.#handleResult);
    this.#sdkSession.on("error", this.#handleError);
    this.#sdkSession.on("finished", this.#handleFinished);
  }

  get closed(): Promise<void> {
    return this.#closedController.promise;
  }

  sendAudio(data: Buffer): void {
    try {
      this.#sdkSession.sendAudio(data);
    } catch (error) {
      throw new RealtimeTranscriptionFailure(toRealtimeFailureReason(error), { cause: error });
    }
  }

  async finish(): Promise<void> {
    try {
      await this.#sdkSession.finish();
    } catch (error) {
      throw new RealtimeTranscriptionFailure(toRealtimeFailureReason(error), { cause: error });
    }
  }

  cancel(): void {
    this.#sdkSession.close();
    this.#removeListeners();
    this.#succeed();
  }

  close(): void {
    this.#sdkSession.close();
    this.#removeListeners();
    this.#succeed();
  }

  readonly #handleResult = (result: unknown): void => {
    try {
      this.#onEvent(parseSonioxRealtimeResult(result, { maxAudioDurationMs: this.#maxAudioDurationMs }));
    } catch (error) {
      this.#fail(error);
    }
  };

  readonly #handleError = (error: unknown): void => {
    // `{ error_code }` is the documented provider message shape, but the SDK
    // consumes it internally and emits Error subclasses (AuthError, QuotaError,
    // ConnectionError, NetworkError…) carrying `code`/`statusCode` on this
    // channel instead. Classifying solely with the payload parser reported every
    // real provider failure as malformed output, which both mis-reported the
    // client-facing code (an expired key retried forever as internal_error) and
    // skipped usage recording, because MalformedOutput carries recordUsage:false.
    // Prefer the payload mapping when the shape genuinely matches, and fall back
    // to SDK-error classification otherwise.
    if (isProviderErrorPayload(error)) {
      try {
        parseSonioxRealtimeError(error);
      } catch (failure) {
        this.#fail(failure);
        return;
      }
    }

    this.#fail(new RealtimeTranscriptionFailure(toRealtimeFailureReason(error)));
  };

  readonly #handleFinished = (): void => {
    this.#onEvent({ type: RealtimeProviderEventType.Finished });
    this.#succeed();
  };

  #fail(error: unknown): void {
    this.#removeListeners();
    if (this.#settled) {
      return;
    }

    this.#settled = true;
    if (error instanceof RealtimeTranscriptionFailure) {
      this.#closedController.reject(error);
      return;
    }

    this.#closedController.reject(
      new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.MalformedOutput, { cause: error }),
    );
  }

  #succeed(): void {
    this.#removeListeners();
    if (this.#settled) {
      return;
    }

    this.#settled = true;
    this.#closedController.resolve();
  }

  #removeListeners(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#sdkSession.off("result", this.#handleResult);
    this.#sdkSession.off("error", this.#handleError);
    this.#sdkSession.off("finished", this.#handleFinished);
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  #reject: ((reason?: unknown) => void) | null = null;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  resolve(value: T): void {
    this.#resolve?.(value);
    this.#resolve = null;
    this.#reject = null;
  }

  reject(reason: unknown): void {
    this.#reject?.(reason);
    this.#resolve = null;
    this.#reject = null;
  }
}

/**
 * Whether a value claims to be the provider's raw `{ error_code }` message
 * rather than an SDK `Error`. A value that claims that shape is validated
 * strictly, so a malformed one still reports as malformed output instead of
 * being silently reclassified as a transport failure.
 */
function isProviderErrorPayload(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && !(value instanceof Error) && ("error_code" in value || "error_message" in value)
  );
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function waitForConnect(connect: Promise<void>, timeoutSignal: AbortSignal, timeoutMs: number): Promise<void> {
  if (timeoutSignal.aborted) {
    throw new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.Timeout);
  }

  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      connect,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.Timeout)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SonioxRealtimeClient,
  type SonioxRealtimeSdkSession,
} from "../../src/clients/soniox-realtime-transcription-client.js";
import {
  RealtimeAudioEncoding,
  RealtimeTranscriptionFailure,
  RealtimeTranscriptionFailureReason,
} from "../../src/types/transcription.js";

type EventName = "result" | "error" | "finished";

class FakeRealtimeSession implements SonioxRealtimeSdkSession {
  readonly config: unknown;
  readonly options: unknown;
  readonly calls: string[] = [];
  readonly handlers = new Map<EventName, Set<(value: unknown) => void>>();
  connectResult: Promise<void> = Promise.resolve();
  sendError: Error | null = null;

  constructor(config: unknown, options: unknown) {
    this.config = config;
    this.options = options;
  }

  connect(): Promise<void> {
    this.calls.push("connect");
    return this.connectResult;
  }

  sendAudio(_data: Buffer | Uint8Array | ArrayBuffer): void {
    this.calls.push("sendAudio");
    if (this.sendError !== null) {
      throw this.sendError;
    }
  }

  finish(): Promise<void> {
    this.calls.push("finish");
    return Promise.resolve();
  }

  close(): void {
    this.calls.push("close");
  }

  on(event: EventName, handler: (value: unknown) => void): this {
    const current = this.handlers.get(event) ?? new Set<(value: unknown) => void>();
    current.add(handler);
    this.handlers.set(event, current);
    return this;
  }

  off(event: EventName, handler: (value: unknown) => void): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  emit(event: EventName, value?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(value);
    }
  }
}

function createClient(session: FakeRealtimeSession): SonioxRealtimeClient {
  return new SonioxRealtimeClient({
    sdk: {
      realtime: {
        stt: (config, options) => {
          Object.assign(session, { config, options });
          return session;
        },
      },
    },
    model: "stt-rt-v5",
    connectTimeoutMs: 10,
  });
}

describe("SonioxRealtimeClient", () => {
  it("configures the official realtime stt session with server-owned settings", async () => {
    const session = new FakeRealtimeSession(null, null);
    const events: unknown[] = [];
    const client = createClient(session);

    await client.connect({
      audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 44100, channels: 1 },
      terms: ["Sesori"],
      maxAudioDurationMs: 1_000,
      signal: undefined,
      onEvent: (event) => events.push(event),
    });

    assert.deepEqual(session.config, {
      model: "stt-rt-v5",
      audio_format: "pcm_s16le",
      sample_rate: 44100,
      num_channels: 1,
      language_hints: ["en"],
      language_hints_strict: false,
      enable_endpoint_detection: false,
      enable_language_identification: false,
      enable_speaker_diarization: false,
      context: { terms: ["Sesori"] },
    });
    assert.equal(isSessionOptions(session.options), true);
    assert.deepEqual(events, []);
  });

  it("does not arm the session-lifetime signal with the connect deadline", async () => {
    // The SDK registers options.signal for the whole session and tears the
    // session down when it aborts. AbortSignal.timeout cannot be cancelled, so
    // folding the connect deadline into it would kill every session
    // connectTimeoutMs after it started, making the session cap unreachable.
    const session = new FakeRealtimeSession(null, null);
    const caller = new AbortController();
    const realtimeSession = await createClient(session).connect({
      audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
      terms: [],
      maxAudioDurationMs: 60_000,
      signal: caller.signal,
      onEvent: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    const handed = (session.options as { signal?: AbortSignal } | null)?.signal;
    assert.equal(handed?.aborted ?? false, false, "session-lifetime signal aborted after the connect deadline");

    realtimeSession.sendAudio(Buffer.from([0, 0]));
    assert.ok(session.calls.includes("sendAudio"));

    // The caller's own cancellation must still reach the session.
    caller.abort();
    assert.equal(handed?.aborted, true);
  });

  it("validates provider events before invoking callbacks", async () => {
    const session = new FakeRealtimeSession(null, null);
    const events: unknown[] = [];
    const realtimeSession = await createClient(session).connect({
      audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
      terms: [],
      maxAudioDurationMs: 1_000,
      onEvent: (event) => events.push(event),
    });

    session.emit("result", {
      tokens: [{ text: "ok", confidence: 1, is_final: true }],
      final_audio_proc_ms: 20,
      total_audio_proc_ms: 20,
    });

    assert.deepEqual(events, [
      { type: "transcript", confirmedDelta: "ok", provisional: "", finalAudioMs: 20, totalAudioMs: 20 },
    ]);

    session.emit("result", { tokens: [], final_audio_proc_ms: -1, total_audio_proc_ms: 0 });
    await assert.rejects(realtimeSession.closed, RealtimeTranscriptionFailure);
  });

  it("settles closed on explicit cancel and close without masking provider errors", async () => {
    const cancelled = new FakeRealtimeSession(null, null);
    const cancelledSession = await createClient(cancelled).connect({
      audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
      terms: [],
      maxAudioDurationMs: 1_000,
      onEvent: () => undefined,
    });
    cancelledSession.cancel();
    await cancelledSession.closed;

    const failed = new FakeRealtimeSession(null, null);
    const failedSession = await createClient(failed).connect({
      audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
      terms: [],
      maxAudioDurationMs: 1_000,
      onEvent: () => undefined,
    });
    failed.emit("error", { error_code: 429 });
    failedSession.close();
    await assert.rejects(failedSession.closed, RealtimeTranscriptionFailure);
  });

  it("classifies the Error shapes the SDK actually emits on the error channel", async () => {
    // @soniox/node consumes the raw `{error_code}` payload internally and emits
    // Error subclasses (AuthError, QuotaError, ConnectionError…) carrying
    // `code`/`statusCode`. Treating those as malformed output reported every
    // provider failure as internal_error and skipped usage recording.
    const cases: ReadonlyArray<readonly [Error, RealtimeTranscriptionFailureReason]> = [
      [
        Object.assign(new Error("quota"), { code: "quota_exceeded", statusCode: 429 }),
        RealtimeTranscriptionFailureReason.Capacity,
      ],
      [
        Object.assign(new Error("auth"), { code: "auth_error", statusCode: 401 }),
        RealtimeTranscriptionFailureReason.Configuration,
      ],
    ];

    for (const [emitted, expected] of cases) {
      const session = new FakeRealtimeSession(null, null);
      const realtimeSession = await createClient(session).connect({
        audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
        terms: [],
        maxAudioDurationMs: 1_000,
        onEvent: () => undefined,
      });

      session.emit("error", emitted);

      await assert.rejects(
        realtimeSession.closed,
        (error: unknown) => error instanceof RealtimeTranscriptionFailure && error.reason === expected,
        `expected ${expected} for ${String((emitted as { code?: string }).code)}`,
      );
    }
  });

  it("maps caller abort and own connect timeout distinctly", async () => {
    const callerAbort = new AbortController();
    callerAbort.abort();
    await assert.rejects(
      createClient(new FakeRealtimeSession(null, null)).connect({
        audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
        terms: [],
        maxAudioDurationMs: 1_000,
        signal: callerAbort.signal,
        onEvent: () => undefined,
      }),
      (error: unknown) =>
        error instanceof RealtimeTranscriptionFailure && error.reason === RealtimeTranscriptionFailureReason.Cancelled,
    );

    const hanging = new FakeRealtimeSession(null, null);
    hanging.connectResult = new Promise(() => undefined);
    await assert.rejects(
      createClient(hanging).connect({
        audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
        terms: [],
        maxAudioDurationMs: 1_000,
        onEvent: () => undefined,
      }),
      (error: unknown) =>
        error instanceof RealtimeTranscriptionFailure && error.reason === RealtimeTranscriptionFailureReason.Timeout,
    );
  });

  it("maps provider authentication rejection to configuration without raw provider text", async () => {
    const session = new FakeRealtimeSession(null, null);
    const raw = new Error("401 secret provider body");
    Object.assign(raw, { statusCode: 401 });
    session.connectResult = Promise.reject(raw);

    await assert.rejects(
      createClient(session).connect({
        audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
        terms: [],
        maxAudioDurationMs: 1_000,
        onEvent: () => undefined,
      }),
      (error: unknown) =>
        error instanceof RealtimeTranscriptionFailure &&
        error.reason === RealtimeTranscriptionFailureReason.Configuration &&
        !error.message.includes("401") &&
        !error.message.includes("secret"),
    );
  });

  it("validates structured SDK error events through the Soniox boundary", async () => {
    const auth = new FakeRealtimeSession(null, null);
    const authSession = await createClient(auth).connect({
      audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
      terms: [],
      maxAudioDurationMs: 1_000,
      onEvent: () => undefined,
    });

    auth.emit("error", { error_code: 401, error_message: "secret auth body" });

    await assert.rejects(
      authSession.closed,
      (error: unknown) =>
        error instanceof RealtimeTranscriptionFailure &&
        error.reason === RealtimeTranscriptionFailureReason.Configuration &&
        !error.message.includes("secret"),
    );

    const capacity = new FakeRealtimeSession(null, null);
    const capacitySession = await createClient(capacity).connect({
      audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
      terms: [],
      maxAudioDurationMs: 1_000,
      onEvent: () => undefined,
    });

    capacity.emit("error", { error_code: 429, error_message: "capacity body" });

    await assert.rejects(
      capacitySession.closed,
      (error: unknown) =>
        error instanceof RealtimeTranscriptionFailure && error.reason === RealtimeTranscriptionFailureReason.Capacity,
    );
  });

  it("rejects malformed structured SDK error events as malformed output", async () => {
    const session = new FakeRealtimeSession(null, null);
    const realtimeSession = await createClient(session).connect({
      audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
      terms: [],
      maxAudioDurationMs: 1_000,
      onEvent: () => undefined,
    });

    session.emit("error", { error_code: "401", error_message: "secret" });

    await assert.rejects(
      realtimeSession.closed,
      (error: unknown) =>
        error instanceof RealtimeTranscriptionFailure &&
        error.reason === RealtimeTranscriptionFailureReason.MalformedOutput &&
        !error.message.includes("secret"),
    );
  });

  it("cleans listeners and maps send/finish/cancel boundaries", async () => {
    const session = new FakeRealtimeSession(null, null);
    const realtimeSession = await createClient(session).connect({
      audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: 16000, channels: 1 },
      terms: [],
      maxAudioDurationMs: 1_000,
      onEvent: () => undefined,
    });

    session.sendError = new Error("provider socket raw message");
    assert.throws(
      () => realtimeSession.sendAudio(Buffer.from([0, 0])),
      (error: unknown) =>
        error instanceof RealtimeTranscriptionFailure &&
        error.reason === RealtimeTranscriptionFailureReason.Unavailable,
    );

    await realtimeSession.finish();
    realtimeSession.cancel();
    realtimeSession.close();

    assert.equal(session.handlers.get("result")?.size, 0);
    assert.equal(session.handlers.get("error")?.size, 0);
    assert.equal(session.handlers.get("finished")?.size, 0);
    assert.deepEqual(session.calls, ["connect", "sendAudio", "finish", "close", "close"]);
  });
});

function isSessionOptions(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "signal" in value &&
    "connect_timeout_ms" in value &&
    // The session signal is the caller's cancellation and nothing else, so it is
    // absent when the caller supplied none. It must never be a timeout signal:
    // the SDK holds it for the session's lifetime.
    (value.signal === undefined || value.signal instanceof AbortSignal) &&
    value.connect_timeout_ms === 10
  );
}

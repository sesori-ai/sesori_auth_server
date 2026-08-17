import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  RealtimeTranscriptionClient,
  RealtimeTranscriptionSession,
  RealtimeProviderEvent,
  RealtimeConnectRequest,
} from "../../src/clients/realtime-transcription-client.js";
import type { ProjectKey } from "../../src/models/voice.js";
import { realtimeServerEventSchema } from "../../src/models/voice.js";
import type { DailyUsageRepository } from "../../src/repositories/daily-usage-repo.js";
import {
  RealtimeTranscriptionService,
  type RealtimeTranscriptionPolicy,
} from "../../src/services/realtime-transcription-service.js";
import { RealtimeSessionController } from "../../src/services/realtime-session-controller.js";
import { RealtimeAdmissionError } from "../../src/services/realtime-transcription-errors.js";
import { emitTerminalEvent } from "../../src/services/realtime-public-event-emitter.js";
import type { GlossaryService } from "../../src/services/glossary-service.js";
import {
  RealtimeAudioEncoding,
  RealtimeFinishedReason,
  RealtimeProviderEventType,
  RealtimeProtocolErrorCode,
  RealtimeSampleRate,
  RealtimeTranscriptionFailure,
  RealtimeTranscriptionFailureReason,
} from "../../src/types/transcription.js";

const USER_ID = "6a7603577dee429b4d11b17a";
const PROJECT_KEY = "prj_v1_xgjNDm_yyduAKisFHr498ZgcjIU1FACdyEj68wSmbhc" as ProjectKey;
const POLICY: RealtimeTranscriptionPolicy = {
  dailyLimitSeconds: 10,
  maxSessionSeconds: 5,
  firstAudioTimeoutMs: 25,
  finishTimeoutMs: 25,
  disposeTimeoutMs: 50,
  maxConcurrentSessionsPerUser: 20,
  maxConcurrentSessions: 100,
  audioPaceBurstSeconds: 5,
};

type TestDeferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
};

describe("RealtimeTranscriptionService", () => {
  it("admits with exact project terms and reports quota-bound ready metadata", async () => {
    const harness = createHarness({ usedSeconds: 7.2, terms: ["Sesori"] });

    const session = await harness.start({ projectKey: PROJECT_KEY });

    assert.deepEqual(harness.events, [
      { type: "ready", protocolVersion: 1, maxSessionSeconds: 2, dailySecondsRemaining: 2 },
    ]);
    assert.equal(harness.provider.requests.length, 1);
    assert.deepEqual(harness.provider.requests[0]?.terms, ["Sesori"]);
    assert.equal(harness.glossary.calls, 1);
    assert.equal(session.readyLimitReason, RealtimeFinishedReason.QuotaLimit);
  });

  it("skips glossary lookup when no project is provided and rejects exhausted quota before provider connect", async () => {
    const noProject = createHarness({ usedSeconds: 0 });

    await noProject.start({ projectKey: null });

    assert.equal(noProject.glossary.calls, 0);
    assert.deepEqual(noProject.provider.requests[0]?.terms, []);

    const exhausted = createHarness({ usedSeconds: 10 });

    await assert.rejects(exhausted.start({ projectKey: PROJECT_KEY }), {
      code: RealtimeProtocolErrorCode.QuotaExhausted,
    });
    assert.equal(exhausted.provider.sessions.length, 0);
  });

  it("forwards aligned PCM only, slices the cap frame, and resolves simultaneous cap ties as quota_limit", async () => {
    const harness = createHarness({ usedSeconds: 8, policy: { ...POLICY, maxSessionSeconds: 2 } });
    const session = await harness.start({ sampleRate: RealtimeSampleRate.Rate16000 });

    session.sendAudio(Buffer.alloc(64_002));
    harness.provider.sessions[0]?.emit({ type: RealtimeProviderEventType.Finished });
    await session.closed;

    assert.deepEqual(harness.provider.sessions[0]?.sentBytes, [64_000]);
    assert.deepEqual(harness.provider.sessions[0]?.calls, ["sendAudio", "finish"]);
    assert.equal(harness.usage.increments[0]?.seconds, 2);
    assert.deepEqual(harness.events.at(-1), {
      type: "complete",
      reason: RealtimeFinishedReason.QuotaLimit,
      dailySecondsRemaining: 0,
    });
  });

  it("reports integer complete remaining when fractional usage crosses the wire", async () => {
    const harness = createHarness({
      usedSeconds: 4.4,
      policy: { ...POLICY, dailyLimitSeconds: 10, maxSessionSeconds: 5 },
    });
    const session = await harness.start();

    session.sendAudio(Buffer.alloc(32_000));
    const finishPromise = session.finish();
    harness.provider.sessions[0]?.emit({ type: RealtimeProviderEventType.Finished });
    await finishPromise;

    const complete = harness.events.at(-1);
    assert.deepEqual(complete, {
      type: "complete",
      reason: RealtimeFinishedReason.Finished,
      dailySecondsRemaining: 4,
    });
    assert.equal(realtimeServerEventSchema.safeParse(complete).success, true);
  });

  it("appends confirmed deltas once and replaces provisional text per provider result", async () => {
    const harness = createHarness();
    const session = await harness.start();
    const providerSession = harness.provider.sessions[0];

    providerSession?.emit({
      type: RealtimeProviderEventType.Transcript,
      confirmedDelta: "hello ",
      provisional: "wor",
      finalAudioMs: 100,
      totalAudioMs: 150,
    });
    providerSession?.emit({
      type: RealtimeProviderEventType.Transcript,
      confirmedDelta: "",
      provisional: "world",
      finalAudioMs: 100,
      totalAudioMs: 220,
    });
    providerSession?.emit({
      type: RealtimeProviderEventType.Transcript,
      confirmedDelta: "world",
      provisional: "",
      finalAudioMs: 220,
      totalAudioMs: 220,
    });
    session.sendAudio(Buffer.alloc(320));
    await session.finish();

    assert.deepEqual(
      harness.events.filter((event) => event.type === "transcript"),
      [
        { type: "transcript", confirmedDelta: "hello ", provisional: "wor" },
        { type: "transcript", confirmedDelta: "", provisional: "world" },
        { type: "transcript", confirmedDelta: "world", provisional: "" },
      ],
    );
    assert.deepEqual(
      harness.events
        .filter((event) => event.type === "transcript")
        .map((event) => event.confirmedDelta)
        .join(""),
      "hello world",
    );
  });

  it("finishes after late final provider transcript and records usage once per terminal claim", async () => {
    const finished = createHarness();
    const finishedSession = await finished.start();
    finishedSession.sendAudio(Buffer.alloc(320));
    const finishPromise = finishedSession.finish();
    finished.provider.sessions[0]?.emit({
      type: RealtimeProviderEventType.Transcript,
      confirmedDelta: "late",
      provisional: "",
      finalAudioMs: 11,
      totalAudioMs: 11,
    });
    finished.provider.sessions[0]?.emit({ type: RealtimeProviderEventType.Finished });
    await finishPromise;

    assert.deepEqual(finished.provider.sessions[0]?.calls, ["sendAudio", "finish"]);
    assert.equal(finished.usage.increments.length, 1);
    assert.equal(finished.events.at(-1)?.type, "complete");
    assert.deepEqual(
      finished.events
        .filter((event) => event.type === "transcript")
        .map((event) => event.confirmedDelta)
        .join(""),
      "late",
    );

    const ignoredEventCount = finished.events.length;
    await Promise.all([finishedSession.cancel(), finishedSession.disconnect()]);
    assert.equal(finished.events.length, ignoredEventCount);
  });

  it("cancel and disconnect are silent public terminals but still persist usage", async () => {
    const cancelled = createHarness();
    const cancelledSession = await cancelled.start();
    cancelledSession.sendAudio(Buffer.alloc(320));
    await cancelledSession.cancel();

    assert.deepEqual(cancelled.provider.sessions[0]?.calls, ["sendAudio", "cancel"]);
    assert.deepEqual(cancelled.events, [
      { type: "ready", protocolVersion: 1, maxSessionSeconds: 5, dailySecondsRemaining: 10 },
    ]);
    assert.equal(cancelled.usage.increments[0]?.seconds, 1);

    const disconnected = createHarness();
    const disconnectedSession = await disconnected.start();
    disconnectedSession.sendAudio(Buffer.alloc(320));
    await disconnectedSession.disconnect();

    assert.deepEqual(disconnected.provider.sessions[0]?.calls, ["sendAudio", "cancel"]);
    assert.deepEqual(disconnected.events, [
      { type: "ready", protocolVersion: 1, maxSessionSeconds: 5, dailySecondsRemaining: 10 },
    ]);
    assert.equal(disconnected.usage.increments.length, 1);
  });

  it("maps provider errors to exact public errors without partial text or remaining usage", async () => {
    const harness = createHarness();
    const session = await harness.start();
    const providerSession = harness.provider.sessions[0];

    providerSession?.emit({
      type: RealtimeProviderEventType.Transcript,
      confirmedDelta: "safe",
      provisional: "draft",
      finalAudioMs: 50,
      totalAudioMs: 60,
    });
    session.sendAudio(Buffer.alloc(320));
    providerSession?.fail(new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.Unavailable));
    await session.closed;

    assert.deepEqual(harness.events.at(-1), {
      type: "error",
      code: RealtimeProtocolErrorCode.ProviderUnavailable,
      retryable: true,
    });
  });

  it("skips usage when provider boundary malformed output closes after accepted audio", async () => {
    const harness = createHarness();
    const session = await harness.start();
    const providerSession = harness.provider.sessions[0];

    session.sendAudio(Buffer.alloc(320));
    providerSession?.fail(new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.MalformedOutput));
    await session.closed;

    assert.deepEqual(harness.events.at(-1), {
      type: "error",
      code: RealtimeProtocolErrorCode.InternalError,
      retryable: true,
    });
    assert.equal(harness.usage.increments.length, 0);
  });

  it("records accepted audio when other provider errors close the session", async () => {
    const harness = createHarness();
    const session = await harness.start();
    const providerSession = harness.provider.sessions[0];

    session.sendAudio(Buffer.alloc(320));
    providerSession?.fail(new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.Unavailable));
    await session.closed;

    assert.deepEqual(harness.events.at(-1), {
      type: "error",
      code: RealtimeProtocolErrorCode.ProviderUnavailable,
      retryable: true,
    });
    assert.equal(harness.usage.increments[0]?.seconds, 1);
  });

  it("rejects schema-valid multibyte transcript events over the serialized byte cap before callbacks", async () => {
    const harness = createHarness();
    const session = await harness.start();
    const providerSession = harness.provider.sessions[0];

    providerSession?.emit({
      type: RealtimeProviderEventType.Transcript,
      confirmedDelta: "safe",
      provisional: "",
      finalAudioMs: 100,
      totalAudioMs: 100,
    });
    providerSession?.emit({
      type: RealtimeProviderEventType.Transcript,
      confirmedDelta: "é".repeat(32_768),
      provisional: "",
      finalAudioMs: 200,
      totalAudioMs: 200,
    });
    await session.closed;

    assert.deepEqual(harness.events, [
      { type: "ready", protocolVersion: 1, maxSessionSeconds: 5, dailySecondsRemaining: 10 },
      { type: "transcript", confirmedDelta: "safe", provisional: "" },
      { type: "error", code: RealtimeProtocolErrorCode.InternalError, retryable: true },
    ]);
    assert.equal(
      harness.events.some((event) => event.type === "transcript" && event.confirmedDelta.includes("é")),
      false,
    );
    assert.equal(harness.provider.sessions[0]?.calls.includes("cancel"), true);
  });

  it("finishes a live session at the admitted wall-clock limit even when audio trickles below the cap", async () => {
    const harness = createHarness({ policy: { ...POLICY, maxSessionSeconds: 1, firstAudioTimeoutMs: 2_000 } });
    const session = await harness.start({ sampleRate: RealtimeSampleRate.Rate16000 });
    const providerSession = harness.provider.sessions[0];
    assert.ok(providerSession);

    session.sendAudio(Buffer.alloc(320));
    await delay(1_050);

    assert.deepEqual(providerSession.calls, ["sendAudio", "finish"]);
    providerSession.emit({ type: RealtimeProviderEventType.Finished });
    await session.closed;

    assert.deepEqual(harness.events.at(-1), {
      type: "complete",
      reason: RealtimeFinishedReason.SessionLimit,
      dailySecondsRemaining: 9,
    });
    assert.equal(harness.usage.increments[0]?.seconds, 1);

    const eventCount = harness.events.length;
    await delay(1_050);
    assert.equal(harness.events.length, eventCount);
  });

  it("handles no-audio completion, usage write failure, and provider progress reconciliation", async () => {
    const noAudio = createHarness();
    const noAudioSession = await noAudio.start();
    await noAudioSession.finish();
    assert.deepEqual(noAudio.provider.sessions[0]?.calls, ["cancel"]);
    assert.equal(noAudio.usage.increments.length, 0);

    const writeFail = createHarness({ incrementError: new Error(`secret ${USER_ID}`) });
    const errors: unknown[][] = [];
    const restore = mockConsoleError(errors);
    try {
      const writeFailSession = await writeFail.start();
      writeFail.provider.sessions[0]?.emit({
        type: RealtimeProviderEventType.Transcript,
        confirmedDelta: "",
        provisional: "",
        finalAudioMs: 500,
        totalAudioMs: 500,
      });
      writeFailSession.sendAudio(Buffer.alloc(320));
      const finishPromise = writeFailSession.finish();
      writeFail.provider.sessions[0]?.emit({ type: RealtimeProviderEventType.Finished });
      await finishPromise;
    } finally {
      restore();
    }

    assert.equal(writeFail.events.at(-1)?.type, "complete");
    assert.equal(JSON.stringify(errors).includes(USER_ID), false);

    const progress = createHarness();
    const progressSession = await progress.start();
    progress.provider.sessions[0]?.emit({
      type: RealtimeProviderEventType.Transcript,
      confirmedDelta: "",
      provisional: "",
      finalAudioMs: 1000,
      totalAudioMs: 1000,
    });
    const progressFinish = progressSession.finish();
    progress.provider.sessions[0]?.emit({ type: RealtimeProviderEventType.Finished });
    await progressFinish;
    assert.equal(progress.usage.increments[0]?.seconds, 1);
  });

  it("rejects provider progress beyond the admitted session limit before usage accounting", async () => {
    const harness = createHarness({ policy: { ...POLICY, maxSessionSeconds: 1 } });
    const session = await harness.start();

    harness.provider.sessions[0]?.emit({
      type: RealtimeProviderEventType.Transcript,
      confirmedDelta: "",
      provisional: "",
      finalAudioMs: 1_001,
      totalAudioMs: 1,
    });
    await session.closed;

    assert.deepEqual(harness.events.at(-1), {
      type: "error",
      code: RealtimeProtocolErrorCode.InternalError,
      retryable: true,
    });
    assert.equal(harness.usage.increments.length, 0);
  });

  it("fails closed to a valid internal error when terminal payload validation fails", async () => {
    const events: ServiceEvent[] = [];

    emitTerminalEvent({
      callbacks: {
        onReady: (event) => events.push(event),
        onTranscript: (event) => events.push(event),
        onComplete: (event) => events.push(event),
        onError: (event) => events.push(event),
      },
      decision: { kind: "complete", reason: RealtimeFinishedReason.Finished },
      remaining: Number.NaN,
    });

    assert.deepEqual(events.at(-1), {
      type: "error",
      code: RealtimeProtocolErrorCode.InternalError,
      retryable: true,
    });
  });

  it("floors fallback complete remaining when usage write fails after fractional admission", async () => {
    const harness = createHarness({ usedSeconds: 4.4, incrementError: new Error("write failed") });
    const errors: unknown[][] = [];
    const restore = mockConsoleError(errors);
    try {
      const session = await harness.start();
      session.sendAudio(Buffer.alloc(32_000));
      const finishPromise = session.finish();
      harness.provider.sessions[0]?.emit({ type: RealtimeProviderEventType.Finished });
      await finishPromise;
    } finally {
      restore();
    }

    const complete = harness.events.at(-1);
    assert.deepEqual(complete, {
      type: "complete",
      reason: RealtimeFinishedReason.Finished,
      dailySecondsRemaining: 4,
    });
    assert.equal(realtimeServerEventSchema.safeParse(complete).success, true);
  });

  it("claims first-audio timeout, finish timeout, provider connect errors, and disposed admission deterministically", async () => {
    const idle = createHarness({ policy: { ...POLICY, firstAudioTimeoutMs: 5 } });
    const idleSession = await idle.start();
    await delay(10);
    await idleSession.closed;
    assert.deepEqual(idle.events.at(-1), {
      type: "error",
      code: RealtimeProtocolErrorCode.AudioTimeout,
      retryable: true,
    });

    const finishTimeout = createHarness({ finishDelayMs: 100, policy: { ...POLICY, finishTimeoutMs: 5 } });
    const finishTimeoutSession = await finishTimeout.start();
    finishTimeoutSession.sendAudio(Buffer.alloc(320));
    await finishTimeoutSession.finish();
    assert.deepEqual(finishTimeout.events.at(-1), {
      type: "error",
      code: RealtimeProtocolErrorCode.ProviderTimeout,
      retryable: true,
    });

    const connectFail = createHarness({
      connectError: new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.Capacity),
    });
    await assert.rejects(connectFail.start(), { code: RealtimeProtocolErrorCode.ProviderCapacity });

    const disposed = createHarness();
    await disposed.service.dispose();
    await assert.rejects(disposed.start(), { code: RealtimeProtocolErrorCode.ServiceRestarting });
  });

  it("maps provider configuration failures to nonretryable provider_rejected without raw provider text", async () => {
    const raw = new Error("401 secret provider body");
    const harness = createHarness({
      connectError: new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.Configuration, { cause: raw }),
    });

    await assert.rejects(
      harness.start(),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === RealtimeProtocolErrorCode.ProviderRejected &&
        !error.message.includes("401") &&
        !error.message.includes("secret"),
    );
    assert.equal(harness.glossary.calls, 0);
    assert.equal(harness.provider.sessions.length, 0);
  });

  it("disposes active sessions idempotently and rejects on timeout while retaining unresolved work", async () => {
    const harness = createHarness({
      incrementDelayMs: 100,
      policy: { ...POLICY, disposeTimeoutMs: 5, firstAudioTimeoutMs: 1_000 },
    });
    const session = await harness.start();
    session.sendAudio(Buffer.alloc(320));

    await assert.rejects(harness.service.dispose(), /dispose_timeout/);
    assert.equal(harness.service.activeSessionCount, 1);
    await assert.rejects(harness.service.dispose(), /dispose_timeout/);
  });

  it("shutdown during quota read waits for admission to settle and prevents provider work", async () => {
    const quotaGate = deferred<number>();
    const harness = createHarness({ usedSecondsGate: quotaGate });

    const start = harness.start();
    await nextTurn();
    const dispose = harness.service.dispose();
    await nextTurn();

    assert.equal(harness.service.activeSessionCount, 1);
    assert.equal(harness.provider.requests.length, 0);
    quotaGate.resolve(0);

    await assert.rejects(start, { code: RealtimeProtocolErrorCode.ServiceRestarting });
    await dispose;
    assert.equal(harness.service.activeSessionCount, 0);
    assert.equal(harness.provider.requests.length, 0);
  });

  it("shutdown during glossary read waits and does not connect afterward", async () => {
    const glossaryGate = deferred<readonly string[]>();
    const harness = createHarness({ termsGate: glossaryGate });

    const start = harness.start({ projectKey: PROJECT_KEY });
    await nextTurn();
    const dispose = harness.service.dispose();
    await nextTurn();

    assert.equal(harness.service.activeSessionCount, 1);
    assert.equal(harness.provider.requests.length, 0);
    glossaryGate.resolve(["Sesori"]);

    await assert.rejects(start, { code: RealtimeProtocolErrorCode.ServiceRestarting });
    await dispose;
    assert.equal(harness.provider.requests.length, 0);
    assert.equal(harness.service.activeSessionCount, 0);
  });

  it("shutdown during provider connect aborts and keeps Mongo close waiting", async () => {
    const connectGate = deferred<RealtimeTranscriptionSession>();
    const harness = createHarness({ connectGate });

    const start = harness.start();
    await nextTurn();
    const dispose = harness.service.dispose();
    await nextTurn();

    assert.equal(harness.provider.requests.length, 1);
    assert.equal(harness.provider.requests[0]?.signal?.aborted, true);
    assert.equal(harness.service.activeSessionCount, 1);
    let mongoClosed = false;
    const mongoClose = dispose.then(() => {
      mongoClosed = true;
    });
    await nextTurn();
    assert.equal(mongoClosed, false);

    connectGate.resolve(new FakeProviderSession(harness.provider.requests[0]!.onEvent, 0));

    await assert.rejects(start, { code: RealtimeProtocolErrorCode.ServiceRestarting });
    await mongoClose;
    assert.equal(harness.service.activeSessionCount, 0);
  });

  it("aborted controller rejects before provider connect work", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const harness = createHarness();
    const controller = new RealtimeSessionController({
      service: harness.service,
      request: {
        userId: USER_ID,
        projectKey: null,
        audio: {
          encoding: RealtimeAudioEncoding.PcmS16Le,
          sampleRate: RealtimeSampleRate.Rate16000,
          channels: 1,
        },
        callbacks: {
          onReady: (event) => harness.events.push(event),
          onTranscript: (event) => harness.events.push(event),
          onComplete: (event) => harness.events.push(event),
          onError: (event) => harness.events.push(event),
        },
        signal: abortController.signal,
      },
      policy: POLICY,
      providerLimitSeconds: 1,
      readyLimitReason: RealtimeFinishedReason.SessionLimit,
      remainingAtAdmission: 0,
    });

    await assert.rejects(controller.connect(harness.provider, []), {
      code: RealtimeProtocolErrorCode.ServiceRestarting,
    });
    assert.equal(harness.provider.requests.length, 0);
  });

  it("keeps distinct users and released slots below the ceilings independent and still handles serialized event size", async () => {
    const serviceCaps = createHarness({ policy: { ...POLICY, firstAudioTimeoutMs: 1_000 } });
    const sessions = await Promise.all(
      Array.from({ length: 11 }, (_, index) => serviceCaps.start({ userId: `${USER_ID}${index}` })),
    );
    await Promise.all(sessions.map((session) => session.cancel()));

    const rate = createHarness({ policy: { ...POLICY, firstAudioTimeoutMs: 1_000 } });
    for (let index = 0; index < 11; index += 1) {
      const session = await rate.start();
      await session.cancel();
    }
    assert.equal(rate.provider.sessions.length, 11);

    const oversized = createHarness();
    const oversizedSession = await oversized.start();
    oversized.provider.sessions[0]?.emit({
      type: RealtimeProviderEventType.Transcript,
      confirmedDelta: "é".repeat(40_000),
      provisional: "",
      finalAudioMs: 0,
      totalAudioMs: 0,
    });
    await oversizedSession.closed;
    assert.deepEqual(oversized.events.at(-1), {
      type: "error",
      code: RealtimeProtocolErrorCode.InternalError,
      retryable: true,
    });

    assert.equal(oversized.provider.sessions[0]?.listenerCount, 0);
  });

  it("invalid PCM alignment maps to invalid_audio", async () => {
    const harness = createHarness();
    const session = await harness.start();

    session.sendAudio(Buffer.alloc(3));
    await session.closed;

    assert.deepEqual(harness.events.at(-1), {
      type: "error",
      code: RealtimeProtocolErrorCode.InvalidAudio,
      retryable: false,
    });
  });

  it("caps concurrent sessions per user before any budget read or provider connect", async () => {
    const harness = createHarness({
      policy: { ...POLICY, firstAudioTimeoutMs: 1_000, maxConcurrentSessionsPerUser: 2 },
    });

    const first = await harness.start();
    const second = await harness.start();
    const readsBeforeRejection = harness.usage.reads;

    await assert.rejects(harness.start(), { code: RealtimeProtocolErrorCode.ProviderCapacity });

    assert.equal(harness.usage.reads, readsBeforeRejection);
    assert.equal(harness.provider.sessions.length, 2);

    await first.cancel();
    const third = await harness.start();

    assert.equal(harness.provider.sessions.length, 3);
    await Promise.all([second.cancel(), third.cancel()]);
  });

  it("caps process-wide concurrent sessions across distinct users", async () => {
    const harness = createHarness({
      policy: { ...POLICY, firstAudioTimeoutMs: 1_000, maxConcurrentSessions: 2, maxConcurrentSessionsPerUser: 2 },
    });

    const first = await harness.start({ userId: `${USER_ID}a` });
    const second = await harness.start({ userId: `${USER_ID}b` });

    await assert.rejects(harness.start({ userId: `${USER_ID}c` }), {
      code: RealtimeProtocolErrorCode.ProviderCapacity,
    });
    assert.equal(harness.provider.sessions.length, 2);

    await first.cancel();
    const third = await harness.start({ userId: `${USER_ID}c` });

    assert.equal(harness.provider.sessions.length, 3);
    await Promise.all([second.cancel(), third.cancel()]);
  });

  it("counts in-flight admissions so a start burst cannot exceed the per-user cap", async () => {
    const quotaGate = deferred<number>();
    const harness = createHarness({
      policy: { ...POLICY, firstAudioTimeoutMs: 1_000, maxConcurrentSessionsPerUser: 3 },
      usedSecondsGate: quotaGate,
    });

    const burst = Promise.allSettled(Array.from({ length: 12 }, () => harness.start()));
    await nextTurn();
    quotaGate.resolve(0);
    const settled = await burst;

    const admitted: { cancel(): Promise<void> }[] = [];
    const rejectedCodes: unknown[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        admitted.push(result.value);
      } else {
        rejectedCodes.push(result.reason instanceof RealtimeAdmissionError ? result.reason.code : result.reason);
      }
    }

    assert.equal(admitted.length, 3);
    assert.equal(harness.provider.sessions.length, 3);
    assert.equal(rejectedCodes.length, 9);
    assert.deepEqual(new Set(rejectedCodes), new Set([RealtimeProtocolErrorCode.ProviderCapacity]));

    await Promise.all(admitted.map((session) => session.cancel()));
  });

  it("rearms the audio deadline on every accepted frame and terminates a silent session", async () => {
    const harness = createHarness({ policy: { ...POLICY, firstAudioTimeoutMs: 120 } });
    const session = await harness.start();

    session.sendAudio(Buffer.alloc(320));
    await delay(40);
    session.sendAudio(Buffer.alloc(320));
    await delay(40);

    assert.equal(harness.events.at(-1)?.type, "ready");

    const terminated = await Promise.race([session.closed.then(() => true), delay(1_000).then(() => false)]);

    assert.equal(terminated, true);
    assert.deepEqual(harness.events.at(-1), {
      type: "error",
      code: RealtimeProtocolErrorCode.AudioTimeout,
      retryable: true,
    });
  });

  it("terminates audio delivered faster than real time beyond the burst allowance", async () => {
    const clock = { nowMs: 1_000 };
    const harness = createHarness({
      now: () => clock.nowMs,
      policy: { ...POLICY, firstAudioTimeoutMs: 1_000, audioPaceBurstSeconds: 1 },
    });
    const session = await harness.start();

    session.sendAudio(Buffer.alloc(32_000));
    assert.deepEqual(harness.provider.sessions[0]?.sentBytes, [32_000]);

    session.sendAudio(Buffer.alloc(320));
    assert.deepEqual(harness.provider.sessions[0]?.sentBytes, [32_000]);

    const terminated = await Promise.race([session.closed.then(() => true), delay(1_000).then(() => false)]);

    assert.equal(terminated, true);
    assert.deepEqual(harness.events.at(-1), {
      type: "error",
      code: RealtimeProtocolErrorCode.InvalidAudio,
      retryable: false,
    });
  });

  // The concurrency ceilings make a leaked slot durable: a session that never
  // releases holds one for the process lifetime, and enough of them lock the
  // user out of realtime entirely.
  it("releases the slot and resolves closed even when a terminal callback throws", async () => {
    const harness = createHarness({ onTerminalEvent: () => raise("terminal callback exploded") });
    const session = await harness.start();
    session.sendAudio(Buffer.alloc(320));

    await assert.rejects(session.shutdown(), /terminal callback exploded/);

    assert.equal(harness.service.activeSessionCount, 0);
    // A slot released but a `closed` left pending would still hang dispose().
    await session.closed;
    // The usage write is ordered before the emit attempt, so it still happened.
    assert.equal(harness.usage.increments.length, 1);
  });

  it("releases the slot and resolves closed when the usage write rejects outright", async () => {
    const released: RealtimeTranscriptionSession[] = [];
    const controller = new RealtimeSessionController({
      service: {
        release: (session) => released.push(session),
        recordUsage: () => Promise.reject(new Error("usage write exploded")),
      },
      request: startRequest(() => undefined),
      policy: POLICY,
      providerLimitSeconds: 5,
      readyLimitReason: RealtimeFinishedReason.SessionLimit,
      remainingAtAdmission: 5,
    });
    const provider = new FakeRealtimeClient(undefined, 0, undefined);
    await controller.connect(provider, []);
    controller.sendAudio(Buffer.alloc(320));

    await assert.rejects(controller.cancel(), /usage write exploded/);

    assert.deepEqual(released, [controller]);
    await controller.closed;
  });

  it("releases pace budget as the session clock advances", async () => {
    const clock = { nowMs: 1_000 };
    const harness = createHarness({
      now: () => clock.nowMs,
      policy: { ...POLICY, firstAudioTimeoutMs: 1_000, audioPaceBurstSeconds: 1 },
    });
    const session = await harness.start();

    session.sendAudio(Buffer.alloc(32_000));
    clock.nowMs += 1_000;
    session.sendAudio(Buffer.alloc(32_000));

    assert.deepEqual(harness.provider.sessions[0]?.sentBytes, [32_000, 32_000]);
    await session.cancel();
  });
});

function createHarness(
  options: {
    usedSeconds?: number;
    terms?: readonly string[];
    policy?: typeof POLICY;
    incrementError?: Error;
    incrementDelayMs?: number;
    connectError?: Error;
    finishDelayMs?: number;
    usedSecondsGate?: TestDeferred<number>;
    termsGate?: TestDeferred<readonly string[]>;
    connectGate?: TestDeferred<RealtimeTranscriptionSession>;
    now?: () => number;
    /** Runs on every terminal callback, so a test can make the client-facing emit throw. */
    onTerminalEvent?: () => void;
  } = {},
) {
  const provider = new FakeRealtimeClient(options.connectError, options.finishDelayMs ?? 0, options.connectGate);
  const glossary = new FakeGlossaryService(options.terms ?? [], options.termsGate);
  const usage = new FakeDailyUsageRepository(
    options.usedSeconds ?? 0,
    options.incrementError ?? null,
    options.incrementDelayMs ?? 0,
    options.usedSecondsGate,
  );
  const events: ServiceEvent[] = [];
  const service = new RealtimeTranscriptionService({
    realtimeClient: provider,
    glossaryService: glossary as unknown as GlossaryService,
    dailyUsageRepo: usage as unknown as DailyUsageRepository,
    policy: options.policy ?? POLICY,
    now: options.now,
  });
  return {
    provider,
    glossary,
    usage,
    events,
    service,
    start: (startOptions: StartOptions = {}) =>
      service.start({
        userId: startOptions.userId ?? USER_ID,
        projectKey: startOptions.projectKey ?? null,
        audio: {
          encoding: RealtimeAudioEncoding.PcmS16Le,
          sampleRate: startOptions.sampleRate ?? RealtimeSampleRate.Rate16000,
          channels: 1,
        },
        callbacks: {
          onReady: (event) => events.push(event),
          onTranscript: (event) => events.push(event),
          onComplete: (event) => {
            events.push(event);
            options.onTerminalEvent?.();
          },
          onError: (event) => {
            events.push(event);
            options.onTerminalEvent?.();
          },
        },
        signal: startOptions.signal ?? new AbortController().signal,
      }),
  };
}

function startRequest(onEvent: () => void): RealtimeStartRequest {
  return {
    userId: USER_ID,
    projectKey: null,
    audio: { encoding: RealtimeAudioEncoding.PcmS16Le, sampleRate: RealtimeSampleRate.Rate16000, channels: 1 },
    callbacks: { onReady: onEvent, onTranscript: onEvent, onComplete: onEvent, onError: onEvent },
    signal: new AbortController().signal,
  };
}

function raise(message: string): never {
  throw new Error(message);
}

type StartOptions = {
  readonly userId?: string;
  readonly projectKey?: ProjectKey | null;
  readonly sampleRate?: RealtimeSampleRate;
  readonly signal?: AbortSignal;
};

type ServiceEvent =
  | {
      readonly type: "ready";
      readonly protocolVersion: 1;
      readonly maxSessionSeconds: number;
      readonly dailySecondsRemaining: number;
    }
  | { readonly type: "transcript"; readonly confirmedDelta: string; readonly provisional: string }
  | { readonly type: "complete"; readonly reason: RealtimeFinishedReason; readonly dailySecondsRemaining: number }
  | {
      readonly type: "error";
      readonly code: RealtimeProtocolErrorCode;
      readonly retryable: boolean;
    };

class FakeGlossaryService {
  calls = 0;
  readonly #terms: readonly string[];
  readonly #termsGate: TestDeferred<readonly string[]> | undefined;

  constructor(terms: readonly string[], termsGate: TestDeferred<readonly string[]> | undefined) {
    this.#terms = terms;
    this.#termsGate = termsGate;
  }

  async getContextWords(): Promise<readonly string[]> {
    this.calls += 1;
    if (this.#termsGate !== undefined) {
      return this.#termsGate.promise;
    }
    return [...this.#terms];
  }
}

class FakeDailyUsageRepository {
  readonly increments: { readonly seconds: number }[] = [];
  reads = 0;
  readonly #usedSeconds: number;
  readonly #incrementError: Error | null;
  readonly #incrementDelayMs: number;
  readonly #usedSecondsGate: TestDeferred<number> | undefined;

  constructor(
    usedSeconds: number,
    incrementError: Error | null,
    incrementDelayMs: number,
    usedSecondsGate: TestDeferred<number> | undefined,
  ) {
    this.#usedSeconds = usedSeconds;
    this.#incrementError = incrementError;
    this.#incrementDelayMs = incrementDelayMs;
    this.#usedSecondsGate = usedSecondsGate;
  }

  async getDailyTranscriptionSeconds(): Promise<number> {
    this.reads += 1;
    if (this.#usedSecondsGate !== undefined) {
      return this.#usedSecondsGate.promise;
    }
    return this.#usedSeconds;
  }

  async incrementTranscriptionSeconds(
    _userId: string,
    seconds: number,
  ): Promise<{ previousTotal: number; newTotal: number }> {
    this.increments.push({ seconds });
    if (this.#incrementDelayMs > 0) {
      await delay(this.#incrementDelayMs);
    }
    if (this.#incrementError !== null) {
      throw this.#incrementError;
    }
    return { previousTotal: this.#usedSeconds, newTotal: this.#usedSeconds + seconds };
  }
}

class FakeRealtimeClient implements RealtimeTranscriptionClient {
  readonly requests: RealtimeConnectRequest[] = [];
  readonly sessions: FakeProviderSession[] = [];
  readonly #connectError: Error | undefined;
  readonly #finishDelayMs: number;
  readonly #connectGate: TestDeferred<RealtimeTranscriptionSession> | undefined;

  constructor(
    connectError: Error | undefined,
    finishDelayMs: number,
    connectGate: TestDeferred<RealtimeTranscriptionSession> | undefined,
  ) {
    this.#connectError = connectError;
    this.#finishDelayMs = finishDelayMs;
    this.#connectGate = connectGate;
  }

  async connect(request: RealtimeConnectRequest): Promise<RealtimeTranscriptionSession> {
    if (request.signal?.aborted === true) {
      throw new RealtimeTranscriptionFailure(RealtimeTranscriptionFailureReason.Unavailable);
    }
    if (this.#connectError !== undefined) {
      throw this.#connectError;
    }
    this.requests.push(request);
    if (this.#connectGate !== undefined) {
      return this.#connectGate.promise;
    }
    const session = new FakeProviderSession(request.onEvent, this.#finishDelayMs);
    this.sessions.push(session);
    return session;
  }
}

class FakeProviderSession implements RealtimeTranscriptionSession {
  readonly calls: string[] = [];
  readonly sentBytes: number[] = [];
  readonly #closed = new Deferred<void>();
  readonly #onEvent: (event: RealtimeProviderEvent) => void;
  readonly #finishDelayMs: number;
  listenerCount = 1;

  constructor(onEvent: (event: RealtimeProviderEvent) => void, finishDelayMs: number) {
    this.#onEvent = onEvent;
    this.#finishDelayMs = finishDelayMs;
  }

  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  sendAudio(data: Buffer): void {
    this.calls.push("sendAudio");
    this.sentBytes.push(data.byteLength);
  }

  async finish(): Promise<void> {
    this.calls.push("finish");
    if (this.#finishDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#finishDelayMs));
    }
  }

  cancel(): void {
    this.calls.push("cancel");
    this.listenerCount = 0;
    this.#closed.resolve();
  }

  close(): void {
    this.calls.push("close");
    this.listenerCount = 0;
    this.#closed.resolve();
  }

  emit(event: RealtimeProviderEvent): void {
    if (event.type === "finished") {
      this.listenerCount = 0;
      this.#closed.resolve();
    }
    this.#onEvent(event);
  }

  fail(error: Error): void {
    this.listenerCount = 0;
    this.#closed.reject(error);
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

function mockConsoleError(errors: unknown[][]): () => void {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  return () => {
    console.error = original;
  };
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred<T>(): TestDeferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

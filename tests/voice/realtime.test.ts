import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { WebSocket, type RawData } from "ws";
import type {
  RealtimeTranscriptionClient,
  RealtimeTranscriptionSession as ProviderSession,
} from "../../src/clients/realtime-transcription-client.js";
import { MAX_REALTIME_EVENT_BYTES, REALTIME_PROTOCOL_ERROR_RETRYABLE } from "../../src/models/voice.js";
import type { DailyUsageRepository } from "../../src/repositories/daily-usage-repo.js";
import { startRealtimeSocket } from "../../src/routes/voice-realtime-socket.js";
import type { RealtimeRoutePolicy } from "../../src/routes/voice-realtime-support.js";
import { createShutdownHandler } from "../../src/shutdown.js";
import type { GlossaryService } from "../../src/services/glossary-service.js";
import { RealtimeAdmissionError } from "../../src/services/realtime-transcription-errors.js";
import {
  RealtimeTranscriptionService,
  type RealtimeStartRequest,
  type RealtimeTranscriptionPolicy,
} from "../../src/services/realtime-transcription-service.js";
import {
  RealtimeFinishedReason,
  RealtimeProtocolErrorCode,
  RealtimeProtocolVersion,
  RealtimeServerEventType,
} from "../../src/types/transcription.js";
import { RecordingTimeoutScheduler } from "../helpers/recording-timeout-scheduler.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

type StartedSession = {
  readonly closed: Promise<void>;
  readonly readyLimitReason: RealtimeFinishedReason;
  sendAudio(data: Buffer): void;
  finish(): Promise<void>;
  cancel(): Promise<void>;
  disconnect(): Promise<void>;
  shutdown(): Promise<void>;
};

class FakeRealtimeSession implements StartedSession {
  readonly closed = Promise.resolve();
  readonly readyLimitReason = RealtimeFinishedReason.SessionLimit;
  readonly audioFrames: Buffer[] = [];
  finished = false;
  cancelled = false;
  disconnected = false;
  cancelError: unknown = null;
  callbacks: RealtimeStartRequest["callbacks"] | null = null;

  sendAudio(data: Buffer): void {
    this.audioFrames.push(data);
  }

  async finish(): Promise<void> {
    this.finished = true;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.cancelError !== null) {
      throw this.cancelError;
    }
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  async shutdown(): Promise<void> {
    this.disconnected = true;
  }
}

class FakeRealtimeService {
  readonly starts: RealtimeStartRequest[] = [];
  readonly sessions: FakeRealtimeSession[] = [];
  disposed = false;

  async start(request: RealtimeStartRequest): Promise<FakeRealtimeSession> {
    if (request.signal.aborted) {
      throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.ServiceRestarting);
    }
    const session = new FakeRealtimeSession();
    session.callbacks = request.callbacks;
    this.starts.push(request);
    this.sessions.push(session);
    request.callbacks.onReady({
      type: RealtimeServerEventType.Ready,
      protocolVersion: RealtimeProtocolVersion.V1,
      maxSessionSeconds: 900,
      dailySecondsRemaining: 3600,
    });
    return session;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class RejectingRealtimeService extends FakeRealtimeService {
  constructor(readonly code: RealtimeProtocolErrorCode) {
    super();
  }

  override async start(request: RealtimeStartRequest): Promise<FakeRealtimeSession> {
    this.starts.push(request);
    throw new RealtimeAdmissionError(this.code);
  }
}

class FakeSocket extends EventEmitter {
  readonly sent: string[] = [];
  readonly closeCodes: number[] = [];
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  sendError: unknown = null;
  terminateError: unknown = null;
  readonly websocket = this as unknown as WebSocket;

  send(data: string): void {
    if (this.sendError !== null) {
      throw this.sendError;
    }
    this.sent.push(data);
  }

  close(code?: number): void {
    this.readyState = 3;
    this.closeCodes.push(code ?? 1005);
    this.emit("close", code ?? 1005);
  }

  terminate(): void {
    if (this.terminateError !== null) {
      throw this.terminateError;
    }
    this.readyState = 3;
  }

  emitText(data: RawData): void {
    this.emit("message", data, false);
  }
}

class SlowStartRealtimeService extends FakeRealtimeService {
  readonly startGate = deferred<void>();

  override async start(request: RealtimeStartRequest): Promise<FakeRealtimeSession> {
    this.starts.push(request);
    await this.startGate.promise;
    if (request.signal.aborted) {
      throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.ServiceRestarting);
    }
    return super.start(request);
  }
}

const SHUTDOWN_POLICY: RealtimeTranscriptionPolicy = {
  dailyLimitSeconds: 3_600,
  maxSessionSeconds: 900,
  firstAudioTimeoutMs: 30_000,
  finishTimeoutMs: 5_000,
  disposeTimeoutMs: 5_000,
  maxConcurrentSessionsPerUser: 4,
  maxConcurrentSessions: 16,
  audioPaceBurstSeconds: 5,
};

class FailingDisposeRealtimeService extends FakeRealtimeService {
  override async dispose(): Promise<void> {
    this.disposed = true;
    throw new Error("dispose_timeout");
  }

  beginShutdown(): void {}
}

class ShutdownProviderSession implements ProviderSession {
  receivedBytes = 0;
  readonly #closed = deferred<void>();

  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  sendAudio(data: Buffer): void {
    this.receivedBytes += data.byteLength;
  }

  async finish(): Promise<void> {}

  cancel(): void {
    this.#closed.resolve(undefined);
  }

  close(): void {
    this.#closed.resolve(undefined);
  }
}

class ShutdownProviderClient implements RealtimeTranscriptionClient {
  readonly sessions: ShutdownProviderSession[] = [];

  async connect(): Promise<ProviderSession> {
    const session = new ShutdownProviderSession();
    this.sessions.push(session);
    return session;
  }
}

class EmptyGlossaryService {
  async getContextWords(): Promise<readonly string[]> {
    return [];
  }
}

/**
 * Stands in for the MongoDB usage write the terminal path awaits. The delay is
 * what makes the ordering observable: the frame can only reach the client if
 * disposal is sequenced ahead of app.close() rather than racing it.
 */
class RoundTripDailyUsageRepository {
  async getDailyTranscriptionSeconds(): Promise<number> {
    return 0;
  }

  async incrementTranscriptionSeconds(
    _userId: string,
    seconds: number,
  ): Promise<{ previousTotal: number; newTotal: number }> {
    await delay(50);
    return { previousTotal: 0, newTotal: seconds };
  }
}

function testRoutePolicy(overrides: Partial<RealtimeRoutePolicy> = {}): RealtimeRoutePolicy {
  return {
    firstFrameTimeoutMs: 5_000,
    maxTextFrameBytes: 2_048,
    maxAudioFrameBytes: 65_536,
    maxOutboundEventBytes: MAX_REALTIME_EVENT_BYTES,
    outboundBufferMaxBytes: 65_536,
    ...overrides,
  };
}

function validStartFrame(): string {
  return JSON.stringify({
    type: "start",
    protocolVersion: 1,
    projectKey: null,
    audio: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  });
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
  });
}

function nextMessageWithin(socket: WebSocket, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`No WebSocket message within ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (data: RawData): void => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString("utf8")));
    };
    socket.once("message", onMessage);
  });
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("voice realtime route", () => {
  describe("when realtime is disabled", () => {
    let ctx: TestContext;

    before(async () => {
      ctx = await createTestApp();
    });

    after(async () => {
      await ctx.cleanup();
    });

    it("returns the exact public capability response", async () => {
      const response = await ctx.app.inject({ method: "GET", url: "/voice/capabilities" });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { realtime: { enabled: false, protocolVersions: [1] } });
    });

    it("does not register the realtime websocket endpoint", async () => {
      const response = await ctx.app.inject({ method: "GET", url: "/voice/realtime" });

      assert.equal(response.statusCode, 404);
    });

    it("keeps realtime disabled when a service is provided with an explicit false config override", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: { REALTIME_TRANSCRIPTION_ENABLED: false, SONIOX_API_KEY: "test-soniox-key" },
      });

      try {
        const capabilities = await localCtx.app.inject({ method: "GET", url: "/voice/capabilities" });
        const route = await localCtx.app.inject({ method: "GET", url: "/voice/realtime" });

        assert.equal(capabilities.statusCode, 200);
        assert.deepEqual(capabilities.json(), { realtime: { enabled: false, protocolVersions: [1] } });
        assert.equal(route.statusCode, 404);
      } finally {
        await localCtx.cleanup();
      }
    });
  });

  describe("when realtime is enabled", () => {
    let ctx: TestContext;
    let realtimeService: FakeRealtimeService;

    before(async () => {
      realtimeService = new FakeRealtimeService();
      ctx = await createTestApp({
        realtimeService,
        configOverrides: { REALTIME_TRANSCRIPTION_ENABLED: true, SONIOX_API_KEY: "test-soniox-key" },
      });
    });

    after(async () => {
      await ctx.cleanup();
    });

    it("returns the exact enabled capability response", async () => {
      const response = await ctx.app.inject({ method: "GET", url: "/voice/capabilities" });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { realtime: { enabled: true, protocolVersions: [1] } });
    });

    it("keeps realtime enabled when a service is provided with an explicit true config override", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: { REALTIME_TRANSCRIPTION_ENABLED: true, SONIOX_API_KEY: "test-soniox-key" },
      });

      try {
        const capabilities = await localCtx.app.inject({ method: "GET", url: "/voice/capabilities" });

        assert.equal(capabilities.statusCode, 200);
        assert.deepEqual(capabilities.json(), { realtime: { enabled: true, protocolVersions: [1] } });
      } finally {
        await localCtx.cleanup();
      }
    });

    it("rejects missing bearer before the websocket handler runs", async () => {
      await assert.rejects(() => ctx.app.injectWS("/voice/realtime"));
      assert.equal(realtimeService.starts.length, 0);
    });

    it("authenticates upgrade bearer and bridges ready and audio frames", async () => {
      const user = await ctx.createUser();
      const socket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      const ready = nextMessage(socket);

      socket.send(validStartFrame());

      assert.deepEqual(await ready, {
        type: "ready",
        protocolVersion: 1,
        maxSessionSeconds: 900,
        dailySecondsRemaining: 3600,
      });
      assert.equal(realtimeService.starts.at(-1)?.userId, user.userId);

      socket.send(Buffer.from([0, 0]));
      await nextTurn();
      assert.equal(realtimeService.sessions.at(-1)?.audioFrames.length, 1);
      socket.terminate();
    });

    // QA-6: the onClose hook is the safety net for closes that bypass the
    // shutdown coordinator. Nothing observed `disposed`, so deleting the hook
    // outright failed no test.
    it("disposes the realtime service when the app closes", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: { REALTIME_TRANSCRIPTION_ENABLED: true, SONIOX_API_KEY: "test-soniox-key" },
      });

      assert.equal(localRealtimeService.disposed, false);
      await localCtx.cleanup();

      assert.equal(localRealtimeService.disposed, true);
    });

    it("rejects a second text frame while start is still resolving", async () => {
      const localRealtimeService = new SlowStartRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: { REALTIME_TRANSCRIPTION_ENABLED: true, SONIOX_API_KEY: "test-soniox-key" },
      });
      const user = await localCtx.createUser();
      try {
        const socket = await localCtx.app.injectWS("/voice/realtime", {
          headers: { authorization: `Bearer ${user.accessToken}` },
        });
        const message = nextMessage(socket);
        const close = nextClose(socket);

        socket.send(validStartFrame());
        socket.send(JSON.stringify({ type: "finish" }));

        assert.deepEqual(await message, { type: "error", code: "invalid_message", retryable: false });
        assert.equal((await close).code, 1008);
        assert.equal(localRealtimeService.starts.length, 1);
        assert.equal(localRealtimeService.starts[0]?.signal.aborted, true);
        localRealtimeService.startGate.resolve();
        await nextTurn();
        assert.equal(localRealtimeService.sessions.length, 0);
      } finally {
        await localCtx.cleanup();
      }
    });

    // CQ-6: terminating out of `starting` sent a terminal error but never set
    // `terminalSent`, so a late service callback passed the only guard
    // `createCallbacks` has. It was harmless purely because `sendEvent` bails on
    // a non-OPEN socket — a property of the transport, not of this state
    // machine. The socket here stays OPEN so the guard itself is under test.
    it("suppresses a late service terminal after terminating from starting", async () => {
      const localRealtimeService = new SlowStartRealtimeService();
      const socket = new FakeSocket();
      socket.close = (code?: number): void => {
        socket.closeCodes.push(code ?? 1005);
      };
      startRealtimeSocket({
        socket: socket.websocket,
        request: { user: { userId: "6a7603577dee429b4d11b17a" } } as never,
        realtimeService: localRealtimeService,
        routePolicy: testRoutePolicy(),
        state: "awaiting_start",
        session: null,
        terminalSent: false,
        startAbortController: null,
      });

      socket.emitText(Buffer.from(validStartFrame()));
      await nextTurn();
      socket.emitText(Buffer.from(JSON.stringify({ type: "finish" })));
      await nextTurn();

      const afterTerminal = socket.sent.map((message) => JSON.parse(message));
      assert.deepEqual(afterTerminal, [{ type: "error", code: "invalid_message", retryable: false }]);
      assert.equal(socket.readyState, socket.OPEN);

      localRealtimeService.starts[0]?.callbacks.onError({
        type: RealtimeServerEventType.Error,
        code: RealtimeProtocolErrorCode.ProviderUnavailable,
        retryable: true,
      });

      assert.deepEqual(
        socket.sent.map((message) => JSON.parse(message)),
        afterTerminal,
      );
      localRealtimeService.startGate.resolve();
    });

    it("rejects binary before ready without queueing frames behind async start", async () => {
      const localRealtimeService = new SlowStartRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: { REALTIME_TRANSCRIPTION_ENABLED: true, SONIOX_API_KEY: "test-soniox-key" },
      });
      const user = await localCtx.createUser();
      try {
        const socket = await localCtx.app.injectWS("/voice/realtime", {
          headers: { authorization: `Bearer ${user.accessToken}` },
        });
        const message = nextMessage(socket);

        socket.send(validStartFrame());
        socket.send(Buffer.from([0, 0]));

        assert.deepEqual(await message, { type: "error", code: "invalid_audio", retryable: false });
        assert.equal(localRealtimeService.starts.length, 1);
        assert.equal(localRealtimeService.starts[0]?.signal.aborted, true);
        localRealtimeService.startGate.resolve();
        await nextTurn();
        assert.equal(localRealtimeService.sessions.length, 0);
        socket.terminate();
      } finally {
        await localCtx.cleanup();
      }
    });

    it("aborts async start on socket close and suppresses late ready events", async () => {
      const localRealtimeService = new SlowStartRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: { REALTIME_TRANSCRIPTION_ENABLED: true, SONIOX_API_KEY: "test-soniox-key" },
      });
      const user = await localCtx.createUser();
      try {
        const socket = await localCtx.app.injectWS("/voice/realtime", {
          headers: { authorization: `Bearer ${user.accessToken}` },
        });

        socket.send(validStartFrame());
        await nextTurn();
        socket.terminate();
        await nextTurn();

        assert.equal(localRealtimeService.starts.length, 1);
        assert.equal(localRealtimeService.starts[0]?.signal.aborted, true);
        localRealtimeService.startGate.resolve();
        await nextTurn();
        assert.equal(localRealtimeService.sessions.length, 0);
      } finally {
        await localCtx.cleanup();
      }
    });

    it("keeps the socket open after finish until the service emits complete", async () => {
      const user = await ctx.createUser();
      const socket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      await sendStartAndWaitForReady(socket);
      const session = realtimeService.sessions.at(-1);
      assert.ok(session);

      socket.send(JSON.stringify({ type: "finish" }));
      await nextTurn();

      assert.equal(session.finished, true);
      assert.equal(socket.readyState, socket.OPEN);

      const complete = nextMessage(socket);
      session.callbacks?.onComplete({
        type: RealtimeServerEventType.Complete,
        reason: RealtimeFinishedReason.Finished,
        dailySecondsRemaining: 3599,
      });
      assert.deepEqual(await complete, { type: "complete", reason: "finished", dailySecondsRemaining: 3599 });
    });

    it("enters finishing before provider finalization resolves", async () => {
      const user = await ctx.createUser();
      const socket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      await sendStartAndWaitForReady(socket);
      const session = realtimeService.sessions.at(-1);
      assert.ok(session);
      const finishGate = deferred<void>();
      session.finish = async (): Promise<void> => {
        session.finished = true;
        await finishGate.promise;
      };

      socket.send(JSON.stringify({ type: "finish" }));
      await nextTurn();
      socket.send(JSON.stringify({ type: "cancel" }));
      await nextTurn();

      assert.equal(session.cancelled, false);
      assert.equal(socket.readyState, socket.OPEN);
      finishGate.resolve(undefined);
      socket.terminate();
    });

    it("accepts differently spaced finish and cancel controls", async () => {
      const finishUser = await ctx.createUser();
      const finishSocket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${finishUser.accessToken}` },
      });
      await sendStartAndWaitForReady(finishSocket);
      const finishSession = realtimeService.sessions.at(-1);
      assert.ok(finishSession);

      finishSocket.send('{  "type" : "finish"  }');
      await nextTurn();
      assert.equal(finishSession.finished, true);
      finishSocket.terminate();

      const cancelUser = await ctx.createUser();
      const cancelSocket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${cancelUser.accessToken}` },
      });
      await sendStartAndWaitForReady(cancelSocket);
      const cancelClose = nextClose(cancelSocket);
      const cancelSession = realtimeService.sessions.at(-1);
      assert.ok(cancelSession);

      cancelSocket.send('{\n  "type" : "cancel"\n}');

      assert.equal((await cancelClose).code, 1000);
      assert.equal(cancelSession.cancelled, true);
    });

    it("rejects whitespace-padded finish and cancel controls over the route text cap", async () => {
      const finishUser = await ctx.createUser();
      const finishSocket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${finishUser.accessToken}` },
      });
      await sendStartAndWaitForReady(finishSocket);
      const finishSession = realtimeService.sessions.at(-1);
      assert.ok(finishSession);
      const finishMessage = nextMessageWithin(finishSocket, 100);
      const finishClose = nextClose(finishSocket);

      finishSocket.send(`${JSON.stringify({ type: "finish" })}${" ".repeat(2_048)}`);

      assert.deepEqual(await finishMessage, { type: "error", code: "invalid_message", retryable: false });
      assert.equal((await finishClose).code, 1008);
      assert.equal(finishSession.finished, false);
      assert.equal(finishSession.cancelled, true);

      const cancelUser = await ctx.createUser();
      const cancelSocket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${cancelUser.accessToken}` },
      });
      await sendStartAndWaitForReady(cancelSocket);
      const cancelSession = realtimeService.sessions.at(-1);
      assert.ok(cancelSession);
      const cancelMessage = nextMessageWithin(cancelSocket, 100);
      const cancelClose = nextClose(cancelSocket);

      cancelSocket.send(`${JSON.stringify({ type: "cancel" })}${" ".repeat(2_048)}`);

      assert.deepEqual(await cancelMessage, { type: "error", code: "invalid_message", retryable: false });
      assert.equal((await cancelClose).code, 1008);
      assert.equal(cancelSession.cancelled, true);
    });

    it("ignores text controls after finish but rejects binary after finish and suppresses later complete", async () => {
      const user = await ctx.createUser();
      const socket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      await sendStartAndWaitForReady(socket);
      const session = realtimeService.sessions.at(-1);
      assert.ok(session);

      socket.send(JSON.stringify({ type: "finish" }));
      await nextTurn();
      assert.equal(session.finished, true);

      socket.send(JSON.stringify({ type: "cancel" }));
      await nextTurn();
      assert.equal(session.cancelled, false);
      assert.equal(socket.readyState, socket.OPEN);

      const message = nextMessageWithin(socket, 100);
      const close = nextClose(socket);
      socket.send(Buffer.from([0, 0]));

      assert.deepEqual(await message, { type: "error", code: "invalid_audio", retryable: false });
      assert.equal((await close).code, 1008);
      assert.equal(session.cancelled, true);

      session.callbacks?.onComplete({
        type: RealtimeServerEventType.Complete,
        reason: RealtimeFinishedReason.Finished,
        dailySecondsRemaining: 3599,
      });
      assert.equal(await noMessageWithin(socket, 25), true);
    });

    it("rejects unknown control fields before session work", async () => {
      const unknownUser = await ctx.createUser();
      const unknownSocket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${unknownUser.accessToken}` },
      });
      await sendStartAndWaitForReady(unknownSocket);
      const unknownMessage = nextMessage(unknownSocket);

      unknownSocket.send(JSON.stringify({ type: "finish", extra: true }));

      assert.deepEqual(await unknownMessage, { type: "error", code: "invalid_message", retryable: false });
      assert.equal(realtimeService.sessions.at(-1)?.finished, false);
    });

    it("rejects malformed UTF-8 text bytes before JSON parsing or service work", async () => {
      const socket = new FakeSocket();
      const localRealtimeService = new FakeRealtimeService();
      startRealtimeSocket({
        socket: socket.websocket,
        request: { user: { userId: "6a7603577dee429b4d11b17a" } } as never,
        realtimeService: localRealtimeService,
        routePolicy: testRoutePolicy(),
        state: "awaiting_start",
        session: null,
        terminalSent: false,
        startAbortController: null,
      });

      socket.emitText(Buffer.from([0xc3, 0x28]));

      assert.deepEqual(
        socket.sent.map((message) => JSON.parse(message)),
        [{ type: "error", code: "invalid_message", retryable: false }],
      );
      assert.equal(socket.closeCodes.at(-1), 1008);
      assert.equal(localRealtimeService.starts.length, 0);
    });

    // The first-frame deadline is the only bound on an idle upgraded socket, so both halves of it
    // are driven through the scheduler seam rather than a real timer: firing it explicitly pins
    // the terminal it produces and the duration it was armed with, neither of which a sleep past
    // a short timeout could observe.
    it("closes an upgraded socket that never sends a start frame with start_timeout", () => {
      const localRealtimeService = new FakeRealtimeService();
      const socket = new FakeSocket();
      const timeouts = new RecordingTimeoutScheduler();
      startRealtimeSocket({
        socket: socket.websocket,
        request: { user: { userId: "6a7603577dee429b4d11b17a" } } as never,
        realtimeService: localRealtimeService,
        routePolicy: testRoutePolicy({ firstFrameTimeoutMs: 5_000 }),
        state: "awaiting_start",
        session: null,
        terminalSent: false,
        startAbortController: null,
        scheduleStartTimeout: timeouts.schedule,
      });

      assert.deepEqual(
        timeouts.armed.map((timeout) => timeout.timeoutMs),
        [5_000],
      );

      timeouts.armed[0]?.fire();

      assert.deepEqual(
        socket.sent.map((message) => JSON.parse(message)),
        [{ type: "error", code: "start_timeout", retryable: true }],
      );
      assert.equal(socket.closeCodes.at(-1), 1013);
      assert.equal(localRealtimeService.starts.length, 0);
    });

    it("cancels the first-frame timeout once a start frame has arrived", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const socket = new FakeSocket();
      const timeouts = new RecordingTimeoutScheduler();
      startRealtimeSocket({
        socket: socket.websocket,
        request: { user: { userId: "6a7603577dee429b4d11b17a" } } as never,
        realtimeService: localRealtimeService,
        routePolicy: testRoutePolicy({ firstFrameTimeoutMs: 5_000 }),
        state: "awaiting_start",
        session: null,
        terminalSent: false,
        startAbortController: null,
        scheduleStartTimeout: timeouts.schedule,
      });

      socket.emitText(Buffer.from(validStartFrame()));
      await nextTurn();

      assert.equal(timeouts.armed[0]?.cancelCount, 1);

      // Belt and braces: a deadline that somehow outlived its cancel must still find the socket
      // past `awaiting_start` and leave the started session alone.
      timeouts.armed[0]?.fire();
      await nextTurn();

      assert.deepEqual(
        socket.sent.map((message) => JSON.parse(message)),
        [{ type: "ready", protocolVersion: 1, maxSessionSeconds: 900, dailySecondsRemaining: 3600 }],
      );
      assert.deepEqual(socket.closeCodes, []);
      assert.equal(localRealtimeService.starts.length, 1);
    });

    it("keeps send and close races non-throwing", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const socket = new FakeSocket();
      startRealtimeSocket({
        socket: socket.websocket,
        request: { user: { userId: "6a7603577dee429b4d11b17a" } } as never,
        realtimeService: localRealtimeService,
        routePolicy: testRoutePolicy(),
        state: "awaiting_start",
        session: null,
        terminalSent: false,
        startAbortController: null,
      });

      socket.sendError = "closed race";

      assert.doesNotThrow(() => socket.emitText(Buffer.from(validStartFrame())));
      assert.equal(socket.closeCodes.at(-1), 1013);
    });

    it("keeps oversized-event close races non-throwing", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const socket = new FakeSocket();
      startRealtimeSocket({
        socket: socket.websocket,
        request: { user: { userId: "6a7603577dee429b4d11b17a" } } as never,
        realtimeService: localRealtimeService,
        routePolicy: testRoutePolicy(),
        state: "awaiting_start",
        session: null,
        terminalSent: false,
        startAbortController: null,
      });
      socket.emitText(Buffer.from(validStartFrame()));
      await nextTurn();
      socket.sendError = "send race";
      socket.close = (): void => {
        throw "close race";
      };
      socket.terminateError = "terminate race";

      assert.doesNotThrow(() => {
        localRealtimeService.sessions.at(-1)?.callbacks?.onTranscript({
          type: RealtimeServerEventType.Transcript,
          confirmedDelta: "x".repeat(70_000),
          provisional: "",
        });
      });
    });

    it("closes slow clients without partially sending the oversized event", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const socket = new FakeSocket();
      startRealtimeSocket({
        socket: socket.websocket,
        request: { user: { userId: "6a7603577dee429b4d11b17a" } } as never,
        realtimeService: localRealtimeService,
        routePolicy: testRoutePolicy(),
        state: "awaiting_start",
        session: null,
        terminalSent: false,
        startAbortController: null,
      });

      socket.emitText(Buffer.from(validStartFrame()));
      await nextTurn();
      assert.deepEqual(
        socket.sent.map((message) => JSON.parse(message)),
        [{ type: "ready", protocolVersion: 1, maxSessionSeconds: 900, dailySecondsRemaining: 3600 }],
      );

      socket.bufferedAmount = 65_537;
      localRealtimeService.sessions.at(-1)?.callbacks?.onTranscript({
        type: RealtimeServerEventType.Transcript,
        confirmedDelta: "not sent",
        provisional: "",
      });

      assert.equal(socket.closeCodes.at(-1), 1013);
      assert.deepEqual(
        socket.sent.map((message) => JSON.parse(message)),
        [{ type: "ready", protocolVersion: 1, maxSessionSeconds: 900, dailySecondsRemaining: 3600 }],
      );
    });

    // An event we built ourselves that will not fit the wire budget is a server
    // defect, and `bufferedAmount` is provably clear on this branch. Reporting
    // slow_client blamed the peer for our bug and advised a retry that could not
    // help, so this pins internal_error and its 1011 close instead.
    it("emits internal_error when the write buffer is clear but the event exceeds the outbound byte cap", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: {
          REALTIME_TRANSCRIPTION_ENABLED: true,
          SONIOX_API_KEY: "test-soniox-key",
          REALTIME_OUTBOUND_BUFFER_MAX_BYTES: 65_536,
        },
      });
      const user = await localCtx.createUser();
      try {
        const socket = await localCtx.app.injectWS("/voice/realtime", {
          headers: { authorization: `Bearer ${user.accessToken}` },
        });
        await sendStartAndWaitForReady(socket);
        const message = nextMessage(socket);
        const close = nextClose(socket);
        localRealtimeService.sessions.at(-1)?.callbacks?.onTranscript({
          type: RealtimeServerEventType.Transcript,
          confirmedDelta: "x".repeat(70_000),
          provisional: "",
        });

        assert.deepEqual(await message, { type: "error", code: "internal_error", retryable: true });
        assert.equal((await close).code, 1011);
      } finally {
        await localCtx.cleanup();
      }
    });

    // PF-7: `sendEvent` returning false must tear the provider session down now.
    // Waiting for the socket `close` event meant a peer that never answers the
    // close handshake kept Soniox streaming, and billing, for up to 30 seconds.
    it("cancels the provider session immediately when an event cannot be delivered", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const socket = new FakeSocket();
      startRealtimeSocket({
        socket: socket.websocket,
        request: { user: { userId: "6a7603577dee429b4d11b17a" } } as never,
        realtimeService: localRealtimeService,
        routePolicy: testRoutePolicy(),
        state: "awaiting_start",
        session: null,
        terminalSent: false,
        startAbortController: null,
      });
      socket.emitText(Buffer.from(validStartFrame()));
      await nextTurn();
      const session = localRealtimeService.sessions.at(-1);
      assert.ok(session);
      assert.equal(session.cancelled, false);

      // Slow peer: the buffer is over the watermark, so the event cannot be
      // handed over and `close` will not be acknowledged either.
      socket.bufferedAmount = 65_537;
      socket.close = (): void => {
        throw "peer never answers the close handshake";
      };
      session.callbacks?.onTranscript({
        type: RealtimeServerEventType.Transcript,
        confirmedDelta: "undeliverable",
        provisional: "",
      });
      await nextTurn();

      assert.equal(session.cancelled, true);
    });

    it("classifies malformed binary while streaming as invalid_audio", async () => {
      const user = await ctx.createUser();
      const socket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      await sendStartAndWaitForReady(socket);
      const message = nextMessage(socket);

      socket.send(Buffer.from([0]));

      assert.deepEqual(await message, { type: "error", code: "invalid_audio", retryable: false });
    });

    // The one-byte case above trips the minimum-length and the odd-length checks
    // at once, so either could be deleted without failing a test. These two
    // frames each trip exactly one: 0 bytes is even, and 3 bytes is long enough.
    for (const [name, frame] of [
      ["zero-length", Buffer.alloc(0)],
      ["odd-length", Buffer.alloc(3)],
    ] as const) {
      it(`rejects a ${name} audio frame as invalid_audio`, async () => {
        const user = await ctx.createUser();
        const socket = await ctx.app.injectWS("/voice/realtime", {
          headers: { authorization: `Bearer ${user.accessToken}` },
        });
        await sendStartAndWaitForReady(socket);
        const session = realtimeService.sessions.at(-1);
        assert.ok(session);
        // Bounded wait: a deleted predicate must fail this test, not hang it.
        const message = nextMessageWithin(socket, 2_000);

        socket.send(frame);

        assert.deepEqual(await message, { type: "error", code: "invalid_audio", retryable: false });
        assert.equal(session.audioFrames.length, 0);
      });
    }

    it("sends the terminal error even when cancelling active session rejects", async () => {
      const user = await ctx.createUser();
      const socket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      await sendStartAndWaitForReady(socket);
      const session = realtimeService.sessions.at(-1);
      assert.ok(session);
      session.cancelError = new Error("cancel failed");
      const message = nextMessage(socket);
      const close = nextClose(socket);

      socket.send(Buffer.from([0]));

      assert.deepEqual(await message, { type: "error", code: "invalid_audio", retryable: false });
      assert.equal((await close).code, 1008);
    });

    it("sends the terminal error even when cancelling active session rejects a non-Error", async () => {
      const user = await ctx.createUser();
      const socket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      await sendStartAndWaitForReady(socket);
      const session = realtimeService.sessions.at(-1);
      assert.ok(session);
      session.cancelError = "cancel failed";
      const message = nextMessage(socket);
      const close = nextClose(socket);

      socket.send(Buffer.from([0]));

      assert.deepEqual(await message, { type: "error", code: "invalid_audio", retryable: false });
      assert.equal((await close).code, 1008);
    });

    it("lets the route classify a one-byte oversized binary frame but transport-rejects materially larger frames", async () => {
      const oversizedUser = await ctx.createUser();
      const oversizedSocket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${oversizedUser.accessToken}` },
      });
      await sendStartAndWaitForReady(oversizedSocket);
      const oversizedMessage = nextMessageWithin(oversizedSocket, 100);
      const oversizedClose = nextClose(oversizedSocket);

      oversizedSocket.send(Buffer.alloc(65_537));

      assert.deepEqual(await oversizedMessage, { type: "error", code: "invalid_audio", retryable: false });
      assert.equal((await oversizedClose).code, 1008);

      const hugeUser = await ctx.createUser();
      const hugeSocket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${hugeUser.accessToken}` },
      });
      await sendStartAndWaitForReady(hugeSocket);
      const hugeClose = nextClose(hugeSocket);

      hugeSocket.send(Buffer.alloc(70_000));

      assert.notEqual((await hugeClose).code, 1008);
      assert.equal(await noMessageWithin(hugeSocket, 25), true);
    });

    it("rejects first text frames over the fixed default route cap", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: {
          REALTIME_TRANSCRIPTION_ENABLED: true,
          SONIOX_API_KEY: "test-soniox-key",
          REALTIME_OUTBOUND_BUFFER_MAX_BYTES: 65_536,
        },
      });
      const user = await localCtx.createUser();
      try {
        const socket = await localCtx.app.injectWS("/voice/realtime", {
          headers: { authorization: `Bearer ${user.accessToken}` },
        });
        const message = nextMessage(socket);

        socket.send("{".padEnd(2_049, " "));

        assert.deepEqual(await message, { type: "error", code: "invalid_message", retryable: false });
      } finally {
        await localCtx.cleanup();
      }
    });

    it("maps missing authenticated user at start to internal_error", async () => {
      const socket = new FakeSocket();
      startRealtimeSocket({
        socket: socket.websocket,
        request: {} as never,
        realtimeService: new FakeRealtimeService(),
        routePolicy: testRoutePolicy(),
        state: "awaiting_start",
        session: null,
        terminalSent: false,
        startAbortController: null,
      });

      socket.emitText(Buffer.from(validStartFrame()));
      await nextTurn();

      assert.deepEqual(
        socket.sent.map((message) => JSON.parse(message)),
        [{ type: "error", code: "internal_error", retryable: true }],
      );
    });

    it("rejects malformed first frames without starting service work", async () => {
      const user = await ctx.createUser();
      const socket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      const message = nextMessage(socket);
      const beforeStarts = realtimeService.starts.length;

      socket.send(JSON.stringify({ type: "start", protocolVersion: 1, projectKey: null }));

      assert.deepEqual(await message, { type: "error", code: "invalid_message", retryable: false });
      assert.equal(realtimeService.starts.length, beforeStarts);
      socket.terminate();
    });

    it("classifies unsupported start protocol separately without starting service work", async () => {
      const user = await ctx.createUser();
      const socket = await ctx.app.injectWS("/voice/realtime", {
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      const message = nextMessage(socket);
      const close = nextClose(socket);
      const beforeStarts = realtimeService.starts.length;

      socket.send(
        JSON.stringify({
          type: "start",
          protocolVersion: 2,
          projectKey: null,
          audio: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
        }),
      );

      assert.deepEqual(await message, { type: "error", code: "unsupported_protocol", retryable: false });
      assert.equal((await close).code, 1008);
      assert.equal(realtimeService.starts.length, beforeStarts);
    });

    const closeCodeCases: readonly { readonly errorCode: RealtimeProtocolErrorCode; readonly closeCode: number }[] = [
      { errorCode: RealtimeProtocolErrorCode.ProviderRejected, closeCode: 1011 },
      { errorCode: RealtimeProtocolErrorCode.AudioTimeout, closeCode: 1011 },
      { errorCode: RealtimeProtocolErrorCode.ProviderTimeout, closeCode: 1011 },
      { errorCode: RealtimeProtocolErrorCode.InternalError, closeCode: 1011 },
      { errorCode: RealtimeProtocolErrorCode.StartTimeout, closeCode: 1013 },
      { errorCode: RealtimeProtocolErrorCode.ProviderCapacity, closeCode: 1013 },
      { errorCode: RealtimeProtocolErrorCode.ProviderUnavailable, closeCode: 1013 },
      { errorCode: RealtimeProtocolErrorCode.SlowClient, closeCode: 1013 },
      { errorCode: RealtimeProtocolErrorCode.ServiceRestarting, closeCode: 1013 },
      { errorCode: RealtimeProtocolErrorCode.InvalidMessage, closeCode: 1008 },
      { errorCode: RealtimeProtocolErrorCode.UnsupportedProtocol, closeCode: 1008 },
      { errorCode: RealtimeProtocolErrorCode.QuotaExhausted, closeCode: 1008 },
      { errorCode: RealtimeProtocolErrorCode.InvalidAudio, closeCode: 1008 },
    ];

    for (const { errorCode, closeCode } of closeCodeCases) {
      it(`closes route errors ${errorCode} with ${closeCode}`, async () => {
        const localCtx = await createTestApp({
          realtimeService: new RejectingRealtimeService(errorCode),
          configOverrides: { REALTIME_TRANSCRIPTION_ENABLED: true, SONIOX_API_KEY: "test-soniox-key" },
        });
        const user = await localCtx.createUser();
        try {
          const socket = await localCtx.app.injectWS("/voice/realtime", {
            headers: { authorization: `Bearer ${user.accessToken}` },
          });
          const message = nextMessage(socket);
          const close = nextClose(socket);

          socket.send(validStartFrame());

          assert.deepEqual(await message, {
            type: "error",
            code: errorCode,
            retryable: REALTIME_PROTOCOL_ERROR_RETRYABLE[errorCode],
          });
          assert.equal((await close).code, closeCode);
        } finally {
          await localCtx.cleanup();
        }
      });
    }

    // The start-rejection table above only reaches closeCodeForError through admission
    // failures. A provider error raised after `ready` takes the onError callback path
    // instead, so the same code-to-close-code mapping has to be pinned for live sessions.
    const midSessionErrorCases: readonly {
      readonly errorCode: RealtimeProtocolErrorCode;
      readonly closeCode: number;
    }[] = [
      { errorCode: RealtimeProtocolErrorCode.ProviderTimeout, closeCode: 1011 },
      { errorCode: RealtimeProtocolErrorCode.ProviderCapacity, closeCode: 1013 },
      { errorCode: RealtimeProtocolErrorCode.QuotaExhausted, closeCode: 1008 },
    ];

    for (const { errorCode, closeCode } of midSessionErrorCases) {
      it(`forwards a mid-session ${errorCode} provider error and closes with ${closeCode}`, async () => {
        const user = await ctx.createUser();
        const socket = await ctx.app.injectWS("/voice/realtime", {
          headers: { authorization: `Bearer ${user.accessToken}` },
        });
        await sendStartAndWaitForReady(socket);
        const session = realtimeService.sessions.at(-1);
        assert.ok(session);
        const message = nextMessageWithin(socket, 200);
        const close = nextClose(socket);

        session.callbacks?.onError({
          type: RealtimeServerEventType.Error,
          code: errorCode,
          retryable: REALTIME_PROTOCOL_ERROR_RETRYABLE[errorCode],
        });

        assert.deepEqual(await message, {
          type: "error",
          code: errorCode,
          retryable: REALTIME_PROTOCOL_ERROR_RETRYABLE[errorCode],
        });
        assert.equal((await close).code, closeCode);
      });
    }

    it("emits exactly one terminal event when the provider reports further errors after the first", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const socket = new FakeSocket();
      startRealtimeSocket({
        socket: socket.websocket,
        request: { user: { userId: "6a7603577dee429b4d11b17a" } } as never,
        realtimeService: localRealtimeService,
        routePolicy: testRoutePolicy(),
        state: "awaiting_start",
        session: null,
        terminalSent: false,
        startAbortController: null,
      });
      socket.emitText(Buffer.from(validStartFrame()));
      await nextTurn();
      const session = localRealtimeService.sessions.at(-1);
      assert.ok(session);

      session.callbacks?.onError({
        type: RealtimeServerEventType.Error,
        code: RealtimeProtocolErrorCode.ProviderTimeout,
        retryable: true,
      });

      const afterFirstTerminal = [...socket.sent];
      assert.deepEqual(
        afterFirstTerminal.map((message) => JSON.parse(message)),
        [
          { type: "ready", protocolVersion: 1, maxSessionSeconds: 900, dailySecondsRemaining: 3600 },
          { type: "error", code: "provider_timeout", retryable: true },
        ],
      );
      assert.deepEqual(socket.closeCodes, [1011]);

      // Re-open the transport so a second terminal event can only be suppressed by the
      // terminalSent guard rather than by the socket already being closed.
      socket.readyState = socket.OPEN;
      session.callbacks?.onError({
        type: RealtimeServerEventType.Error,
        code: RealtimeProtocolErrorCode.ProviderUnavailable,
        retryable: true,
      });
      session.callbacks?.onComplete({
        type: RealtimeServerEventType.Complete,
        reason: RealtimeFinishedReason.Finished,
        dailySecondsRemaining: 3599,
      });

      assert.deepEqual(socket.sent, afterFirstTerminal);
      assert.deepEqual(socket.closeCodes, [1011]);
    });

    it("reports configuration rejections as provider_rejected without raw provider text", async () => {
      const localCtx = await createTestApp({
        realtimeService: new RejectingRealtimeService(RealtimeProtocolErrorCode.ProviderRejected),
        configOverrides: { REALTIME_TRANSCRIPTION_ENABLED: true, SONIOX_API_KEY: "test-soniox-key" },
      });
      const user = await localCtx.createUser();
      try {
        const socket = await localCtx.app.injectWS("/voice/realtime", {
          headers: { authorization: `Bearer ${user.accessToken}` },
        });
        const message = nextMessage(socket);
        const close = nextClose(socket);

        socket.send(validStartFrame());

        const event = await message;
        assert.deepEqual(event, { type: "error", code: "provider_rejected", retryable: false });
        assert.equal(JSON.stringify(event).includes("401"), false);
        assert.equal((await close).code, 1011);
      } finally {
        await localCtx.cleanup();
      }
    });

    // Regression guard for the disposal/app.close() race: @fastify/websocket's
    // preClose closes every client socket, and a session emits its terminal
    // frame only after an awaited usage write. Running the two concurrently
    // dropped the frame and left the client with a bare close.
    it("delivers service_restarting and close 1013 to a live socket during shutdown", async () => {
      const provider = new ShutdownProviderClient();
      const realtimeService = new RealtimeTranscriptionService({
        realtimeClient: provider,
        glossaryService: new EmptyGlossaryService() as unknown as GlossaryService,
        dailyUsageRepo: new RoundTripDailyUsageRepository() as unknown as DailyUsageRepository,
        policy: SHUTDOWN_POLICY,
      });
      const localCtx = await createTestApp({
        realtimeService,
        configOverrides: { REALTIME_TRANSCRIPTION_ENABLED: true, SONIOX_API_KEY: "test-soniox-key" },
      });
      const exitCodes: number[] = [];

      try {
        const user = await localCtx.createUser();
        const baseUrl = await localCtx.app.listen({ port: 0, host: "127.0.0.1" });
        const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/voice/realtime`, {
          headers: { authorization: `Bearer ${user.accessToken}` },
        });
        await new Promise((resolve) => socket.once("open", resolve));
        await sendStartAndWaitForReady(socket);

        // 20 ms of aligned PCM, so the terminal path bills a second and has to
        // await the usage write before it can emit anything.
        socket.send(Buffer.alloc(640));
        await waitFor(() => provider.sessions[0] !== undefined && provider.sessions[0].receivedBytes > 0);

        const terminal = nextMessageWithin(socket, 5_000);
        const closed = nextClose(socket);
        const shutdown = createShutdownHandler({
          app: localCtx.app,
          mongo: { close: async () => undefined },
          waiters: [],
          readDrainers: [],
          producers: [],
          realtimeService,
          exit: (code) => exitCodes.push(code),
          log: () => undefined,
        });

        await shutdown("SIGTERM");

        assert.deepEqual(await terminal, { type: "error", code: "service_restarting", retryable: true });
        assert.equal((await closed).code, 1013);
        assert.deepEqual(exitCodes, [0]);
      } finally {
        await localCtx.cleanup();
      }
    });

    // A drain that fails is degraded, not a failed termination. The onClose
    // safety net re-awaits the same rejected disposal, so it must not turn
    // app.close() into a rejection and take the exit code with it.
    it("keeps a failed realtime drain out of the shutdown exit code", async () => {
      const localCtx = await createTestApp({
        realtimeService: new FailingDisposeRealtimeService(),
        configOverrides: { REALTIME_TRANSCRIPTION_ENABLED: true, SONIOX_API_KEY: "test-soniox-key" },
      });
      const exitCodes: number[] = [];
      let mongoClosed = false;

      try {
        const shutdown = createShutdownHandler({
          app: localCtx.app,
          mongo: {
            close: async () => {
              mongoClosed = true;
            },
          },
          waiters: [],
          readDrainers: [],
          producers: [],
          realtimeService: new FailingDisposeRealtimeService(),
          exit: (code) => exitCodes.push(code),
          log: () => undefined,
        });

        await shutdown("SIGTERM");

        assert.deepEqual(exitCodes, [0]);
        assert.equal(mongoClosed, true);
      } finally {
        await localCtx.cleanup();
      }
    });

    it("enforces the process-wide pre-auth limit before JWT validation", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: {
          REALTIME_TRANSCRIPTION_ENABLED: true,
          SONIOX_API_KEY: "test-soniox-key",
          REALTIME_UPGRADE_MAX_PER_MINUTE: 12,
        },
      });
      const statuses: string[] = [];

      try {
        for (let attempt = 0; attempt < 14; attempt += 1) {
          try {
            const socket = await localCtx.app.injectWS("/voice/realtime", {
              headers: { authorization: "Bearer malformed" },
            });
            socket.terminate();
            statuses.push("upgraded");
          } catch (error) {
            statuses.push(error instanceof Error ? error.message : "rejected");
          }
        }

        assert.ok(
          statuses.some((status) => status.includes("429")),
          JSON.stringify(statuses),
        );
      } finally {
        await localCtx.cleanup();
      }
    });

    it("keeps users sharing a socket IP in independent post-auth buckets", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: {
          REALTIME_TRANSCRIPTION_ENABLED: true,
          SONIOX_API_KEY: "test-soniox-key",
          REALTIME_UPGRADE_MAX_PER_MINUTE: 30,
        },
      });
      const left = await localCtx.createUser();
      const right = await localCtx.createUser();

      try {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const socket = await localCtx.app.injectWS("/voice/realtime", {
            headers: { authorization: `Bearer ${left.accessToken}` },
          });
          socket.terminate();
        }

        await assert.rejects(() =>
          localCtx.app.injectWS("/voice/realtime", { headers: { authorization: `Bearer ${left.accessToken}` } }),
        );

        const rightSocket = await localCtx.app.injectWS("/voice/realtime", {
          headers: { authorization: `Bearer ${right.accessToken}` },
        });
        rightSocket.terminate();
      } finally {
        await localCtx.cleanup();
      }
    });

    // Spoofed forwarding headers have to be proven harmless against each limiter
    // separately. An authenticated attempt is admitted by the pre-auth gate and then
    // counted by the post-auth gate, so a single run cannot tell which one rejected it.
    it("exhausts the pre-auth allowance across varied forwarding headers before authentication runs", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: {
          REALTIME_TRANSCRIPTION_ENABLED: true,
          SONIOX_API_KEY: "test-soniox-key",
          REALTIME_UPGRADE_MAX_PER_MINUTE: 12,
        },
      });
      const statuses: (number | "upgraded")[] = [];

      try {
        for (let attempt = 0; attempt < 16; attempt += 1) {
          statuses.push(
            await attemptUpgrade(localCtx.app, {
              // Invalid bearer keeps the post-auth limiter out of the picture: every
              // admitted attempt dies at authentication, so a 429 can only be pre-auth.
              authorization: "Bearer malformed",
              "x-forwarded-for": `203.0.113.${attempt}`,
              "cf-connecting-ip": `198.51.100.${attempt}`,
            }),
          );
        }

        assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 429, 429, 429, 429]);
        assert.equal(localRealtimeService.starts.length, 0);
      } finally {
        await localCtx.cleanup();
      }
    });

    it("keys the post-auth start limiter to the verified user across varied forwarding headers", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: {
          REALTIME_TRANSCRIPTION_ENABLED: true,
          SONIOX_API_KEY: "test-soniox-key",
          // High enough that the pre-auth gate cannot account for any rejection below.
          REALTIME_UPGRADE_MAX_PER_MINUTE: 1_000,
        },
      });
      const user = await localCtx.createUser();
      const statuses: (number | "upgraded")[] = [];

      try {
        for (let attempt = 0; attempt < 13; attempt += 1) {
          statuses.push(
            await attemptUpgrade(localCtx.app, {
              authorization: `Bearer ${user.accessToken}`,
              "x-forwarded-for": `203.0.113.${attempt}`,
              "cf-connecting-ip": `198.51.100.${attempt}`,
            }),
          );
        }

        assert.deepEqual(statuses, [
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          429,
        ]);
      } finally {
        await localCtx.cleanup();
      }
    });

    // The global rate-limit registration exempts loopback socket peers. Route limiters
    // built with fastify.rateLimit() inherit global params, so this checks the realtime
    // start limiter still applies to a connection the global allowList would exempt —
    // the normal shape when auth sits behind a same-host proxy or tunnel daemon.
    it("applies the post-auth start limiter to loopback peers the global allowList exempts", async () => {
      const localRealtimeService = new FakeRealtimeService();
      const localCtx = await createTestApp({
        realtimeService: localRealtimeService,
        configOverrides: {
          REALTIME_TRANSCRIPTION_ENABLED: true,
          SONIOX_API_KEY: "test-soniox-key",
          REALTIME_UPGRADE_MAX_PER_MINUTE: 1_000,
        },
      });
      const user = await localCtx.createUser();
      const statuses: (number | "upgraded")[] = [];

      try {
        const baseUrl = await localCtx.app.listen({ port: 0, host: "127.0.0.1" });

        // Guard the premise: a globally limited route over this same loopback
        // connection is exempted, so the allowList really does match here.
        const exempted = await fetch(`${baseUrl}/terms`);
        await exempted.text();
        assert.equal(exempted.status, 200);
        assert.equal(exempted.headers.get("x-ratelimit-limit"), null);

        for (let attempt = 0; attempt < 13; attempt += 1) {
          statuses.push(await attemptLoopbackUpgrade(baseUrl, user.accessToken));
        }

        assert.deepEqual(statuses, [
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          "upgraded",
          429,
        ]);
      } finally {
        await localCtx.cleanup();
      }
    });
  });
});

async function sendStartAndWaitForReady(socket: WebSocket): Promise<void> {
  const ready = nextMessage(socket);
  socket.send(validStartFrame());
  await ready;
}

function nextClose(socket: WebSocket): Promise<{ readonly code: number }> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve({ code }));
  });
}

function noMessageWithin(socket: WebSocket, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve(true);
    }, timeoutMs);
    const onMessage = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    socket.once("message", onMessage);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not reached before deadline");
    }
    await delay(1);
  }
}

const UPGRADE_REJECTION_STATUS = /Unexpected server response: (\d+)/;

async function attemptUpgrade(app: FastifyInstance, headers: Record<string, string>): Promise<number | "upgraded"> {
  try {
    const socket = await app.injectWS("/voice/realtime", { headers });
    socket.terminate();
    return "upgraded";
  } catch (error) {
    const status = error instanceof Error ? UPGRADE_REJECTION_STATUS.exec(error.message) : null;
    if (status === null) {
      throw error;
    }

    return Number(status[1]);
  }
}

function attemptLoopbackUpgrade(baseUrl: string, accessToken: string): Promise<number | "upgraded"> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/voice/realtime`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    socket.on("open", () => {
      socket.terminate();
      resolve("upgraded");
    });
    socket.on("unexpected-response", (request, response) => {
      const statusCode = response.statusCode ?? 0;
      response.resume();
      request.destroy();
      resolve(statusCode);
    });
    socket.on("error", reject);
  });
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

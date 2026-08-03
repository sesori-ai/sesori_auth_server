import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { MongoClient } from "mongodb";
import { MongoDbConnector } from "../src/db/mongo-db-connector.js";
import type { DeviceTokenRepository } from "../src/repositories/device-token-repo.js";
import type { AppServices } from "../src/server.js";
import { buildApp } from "../src/server.js";
import { AppClientPresenceService } from "../src/services/app-client-presence-service.js";
import {
  SHUTDOWN_DRAIN_DEADLINE_MS,
  SHUTDOWN_HARD_DEADLINE_MS,
  SHUTDOWN_IDLE_REAP_INTERVAL_MS,
  cleanupPartialStartup,
  createShutdownCoordinator,
  type ShutdownRequestWaiters,
} from "../src/shutdown.js";
import type { MainOptions, ProductionRuntime, SignalTarget } from "../src/index.js";

const deferred = <T>() => Promise.withResolvers<T>();

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const processSignalCounts = (): number[] => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const record = (events: string[], event: string) => (): void => void events.push(event);
const recordAsync = (events: string[], event: string) => async (): Promise<void> => void events.push(event);

function createRuntime(events: string[], startFails = false): ProductionRuntime {
  return {
    app: {
      close: recordAsync(events, "app.close"),
      server: { closeAllConnections: record(events, "app.force"), closeIdleConnections: record(events, "app.reap") },
    },
    bridgeStateTracker: { dispose: recordAsync(events, "bridge.dispose"), forceFence: record(events, "bridge.force") },
    activationReminderService: {
      start: () => {
        events.push("activation.start");
        if (startFails) {
          throw new Error("PRIVATE_START_FAILURE");
        }
      },
      dispose: recordAsync(events, "activation.dispose"),
      forceFence: record(events, "activation.force"),
    },
    dbConnector: { close: recordAsync(events, "db.close") },
  } as unknown as ProductionRuntime;
}

function createHarness(options?: {
  resolveAppCloseOnForce?: boolean;
  waiterDrain?: ReturnType<typeof deferred<void>>;
  requestWaiters?: ShutdownRequestWaiters[];
  admittedHandler?: () => Promise<void>;
}) {
  const events: string[] = [];
  const exits: number[] = [];
  const drains = { app: deferred<void>(), bridge: deferred<void>(), activation: deferred<void>() };
  const drain = (stage: keyof typeof drains) => () => {
    events.push(`${stage}.${stage === "app" ? "close" : "dispose"}`);
    return drains[stage].promise;
  };
  const requestWaiters = [...(options?.requestWaiters ?? [])];
  if (options?.waiterDrain) {
    requestWaiters.unshift({
      releaseWaiters: record(events, "waiters.release"),
      drainReleasedReads: () => options.waiterDrain!.promise,
    });
  }
  const coordinator = createShutdownCoordinator({
    app: {
      close: async () => void (await Promise.all([drain("app")(), options?.admittedHandler?.()])),
      closeAllConnections: () => {
        events.push("app.force");
        if (options?.resolveAppCloseOnForce) {
          drains.app.resolve();
        }
      },
      closeIdleConnections: record(events, "app.reap"),
    },
    bridgeStateTracker: { dispose: drain("bridge"), forceFence: record(events, "bridge.force") },
    activationReminderService: { dispose: drain("activation"), forceFence: record(events, "activation.force") },
    requestWaiters,
    dbConnector: { close: recordAsync(events, "db.close") },
    selectExit: (code) => exits.push(code),
  });
  return { events, exits, drains, coordinator };
}

function partialResources(events: string[], close: Promise<void>, onForce?: () => void) {
  return {
    app: {
      close: async () => {
        events.push("app.close");
        await close;
      },
      closeAllConnections: () => {
        events.push("app.force");
        onForce?.();
      },
    },
    dbConnector: { close: recordAsync(events, "db.close") },
  };
}

async function startMain(startRuntime: NonNullable<MainOptions["startRuntime"]>, now?: () => number) {
  const { main } = await import("../src/index.js");
  const target = new EventEmitter();
  const exits: number[] = [];
  return {
    target,
    exits,
    starting: main({ startRuntime, signalTarget: target as SignalTarget, selectExit: (code) => exits.push(code), now }),
  };
}

describe("shutdown coordinator", () => {
  it("memoizes duplicate signals and closes MongoDB only after every drain fulfills", async () => {
    const harness = createHarness();
    const first = harness.coordinator.shutdown("SIGTERM");
    assert.equal(first, harness.coordinator.shutdown("SIGINT"));
    assert.deepEqual(harness.events, ["bridge.dispose", "activation.dispose", "app.close"]);
    Object.values(harness.drains).forEach((drain) => drain.resolve());
    assert.deepEqual([await first, harness.events.at(-1), harness.exits], [0, "db.close", [0]]);
  });

  it("reaps idle sockets and closes MongoDB last when fencing recovers the final drain", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const harness = createHarness({ resolveAppCloseOnForce: true });
    const shutdown = harness.coordinator.shutdown("SIGTERM");
    harness.drains.bridge.resolve();
    harness.drains.activation.resolve();

    t.mock.timers.tick(SHUTDOWN_IDLE_REAP_INTERVAL_MS);
    await flushMicrotasks();
    t.mock.timers.tick(SHUTDOWN_IDLE_REAP_INTERVAL_MS);
    await flushMicrotasks();
    assert.equal(harness.events.filter((event) => event === "app.reap").length, 2);
    t.mock.timers.tick(SHUTDOWN_DRAIN_DEADLINE_MS - 2 * SHUTDOWN_IDLE_REAP_INTERVAL_MS);
    await flushMicrotasks();
    assert.equal(harness.events.includes("app.force"), true);
    assert.deepEqual([await shutdown, harness.events.at(-1), harness.exits], [0, "db.close", [0]]);
  });

  it("holds MongoDB for waiter drains and an admitted read started after release", async () => {
    const waiterDrain = deferred<void>();
    const read = deferred<boolean>();
    let handlerResult: boolean | undefined;
    const presence = new AppClientPresenceService({
      deviceTokenRepo: { hasAnyForUser: () => read.promise } as DeviceTokenRepository,
    });
    const harness = createHarness({
      waiterDrain,
      requestWaiters: [presence],
      admittedHandler: async () => {
        handlerResult = await presence.hasRegisteredClient({ userId: "admitted-user" });
      },
    });

    const shutdown = harness.coordinator.shutdown("SIGTERM");
    await flushMicrotasks();
    assert.equal(harness.events[0], "waiters.release");
    Object.values(harness.drains).forEach((drain) => drain.resolve());
    await flushMicrotasks();
    assert.equal(harness.events.includes("db.close"), false);

    read.resolve(true);
    await flushMicrotasks();
    assert.equal(handlerResult, true);
    assert.equal(harness.events.includes("db.close"), false);

    waiterDrain.resolve();
    assert.deepEqual([await shutdown, harness.events.at(-1)], [0, "db.close"]);
  });

  it("ignores initial connection failure but exits 1 for a production MongoDB client-close rejection", async (t) => {
    let connectFails = true;
    t.mock.method(console, "error", () => {});
    t.mock.method(MongoClient.prototype, "connect", async function () {
      if (connectFails) {
        throw new Error("PRIVATE_CONNECT_FAILURE");
      }

      return this;
    });
    t.mock.method(MongoClient.prototype, "close", async () => {
      throw new Error("PRIVATE_CLOSE_FAILURE");
    });
    await new MongoDbConnector({ connectionString: "mongodb://unused" }).close();

    connectFails = false;
    const exits: number[] = [];
    const coordinator = createShutdownCoordinator({
      app: { close: async () => {}, closeAllConnections: () => {}, closeIdleConnections: () => {} },
      bridgeStateTracker: { dispose: async () => {}, forceFence: () => {} },
      activationReminderService: { dispose: async () => {}, forceFence: () => {} },
      dbConnector: new MongoDbConnector({ connectionString: "mongodb://unused" }),
      selectExit: (code) => exits.push(code),
    });

    assert.equal(await coordinator.shutdown("SIGTERM"), 1);
    assert.deepEqual(exits, [1]);
  });
});

describe("startup and signal composition", () => {
  it("imports index without registering signals and keeps installed callbacks through shutdown", async () => {
    const before = processSignalCounts();
    await import("../src/index.js");
    assert.deepEqual(processSignalCounts(), before);

    const events: string[] = [];
    const { target, exits, starting } = await startMain(async () => createRuntime(events));
    const handle = await starting;

    target.emit("SIGINT");
    await handle.shutdownCoordinator.shutdown("SIGTERM");
    assert.deepEqual(exits, [0]);
    handle.removeSignalHandlers();
    assert.deepEqual([target.listenerCount("SIGINT"), target.listenerCount("SIGTERM")], [0, 0]);
  });

  it("removes attempted listeners and cleans DB-last after startup failures", async () => {
    const { main } = await import("../src/index.js");
    for (const failure of ["listener", "scheduler"] as const) {
      const events: string[] = [];
      const emitter = new EventEmitter();
      const signalTarget: SignalTarget = {
        on: (signal, listener) => {
          emitter.on(signal, listener);
          if (failure === "listener" && signal === "SIGTERM") {
            throw new Error("PRIVATE_LISTENER_FAILURE");
          }
        },
        off: (signal, listener) => emitter.off(signal, listener),
      };

      await assert.rejects(
        main({
          startRuntime: async () => createRuntime(events, failure === "scheduler"),
          signalTarget,
          selectExit: () => {},
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.name === "ProductionStartupError" &&
          error.cause instanceof Error &&
          error.cause.message === (failure === "listener" ? "PRIVATE_LISTENER_FAILURE" : "PRIVATE_START_FAILURE"),
      );

      assert.deepEqual([emitter.listenerCount("SIGINT"), emitter.listenerCount("SIGTERM")], [0, 0], failure);
      assert.equal(events.at(-1), failure === "listener" ? undefined : "db.close", failure);
    }
  });

  it("reaches the hard deadline from signal receipt when startup never resolves", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events: string[] = [];
    let now = 5_000;
    const owned = createRuntime(events);
    const { target, exits, starting } = await startMain(
      ({ ownership }) => {
        ownership.bridgeStateTracker = owned.bridgeStateTracker;
        ownership.dbConnector = owned.dbConnector;
        return new Promise<ProductionRuntime>(() => {});
      },
      () => now,
    );

    target.emit("SIGTERM");
    now += SHUTDOWN_HARD_DEADLINE_MS - 1;
    t.mock.timers.tick(SHUTDOWN_HARD_DEADLINE_MS - 1);
    await flushMicrotasks();
    assert.deepEqual(exits, []);

    now += 1;
    t.mock.timers.tick(1);
    const handle = await starting;
    assert.deepEqual([exits, events.includes("bridge.force"), events.includes("db.close")], [[1], true, false]);
    handle.removeSignalHandlers();
  });

  it("uses only the remaining signal-time budget when startup later resolves", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events: string[] = [];
    const startup = deferred<ProductionRuntime>();
    const appClose = deferred<void>();
    let now = 0;
    const runtime = createRuntime(events);
    runtime.app.close = () => {
      events.push("app.close");
      return appClose.promise;
    };
    runtime.app.server.closeAllConnections = () => {
      events.push("app.force");
      appClose.resolve();
    };
    const { target, exits, starting } = await startMain(
      () => startup.promise,
      () => now,
    );

    target.emit("SIGINT");
    now = SHUTDOWN_DRAIN_DEADLINE_MS - 1_000;
    t.mock.timers.tick(SHUTDOWN_DRAIN_DEADLINE_MS - 1_000);
    startup.resolve(runtime);
    await flushMicrotasks();
    assert.equal(events.includes("app.close"), true);
    assert.equal(events.includes("app.force"), false);

    now = SHUTDOWN_DRAIN_DEADLINE_MS;
    t.mock.timers.tick(1_000);
    const handle = await starting;
    assert.deepEqual([events.at(-1), exits], ["db.close", [0]]);
    handle.removeSignalHandlers();
  });

  it("treats a checkpoint interruption as successful shutdown and cleans partial ownership DB-last", async () => {
    const events: string[] = [];
    const checkpoint = deferred<void>();
    const { target, exits, starting } = await startMain(async ({ ownership, throwIfShutdownRequested }) => {
      Object.assign(ownership, createRuntime(events));
      await checkpoint.promise;
      throwIfShutdownRequested();
      throw new Error("checkpoint did not interrupt startup");
    });

    target.emit("SIGTERM");
    checkpoint.resolve();
    const handle = await starting;
    assert.deepEqual(
      [events.at(-1), exits, events.includes("activation.start"), events.includes("app.force")],
      ["db.close", [0], false, false],
    );
    handle.removeSignalHandlers();
  });

  it("buildApp closes its owned Fastify instance before rethrowing registration failure", async (t) => {
    const app = Fastify({ disableRequestLogging: true });
    const originalClose = app.close.bind(app);
    const close = t.mock.method(app, "close", originalClose);
    const services = Object.defineProperty({} as AppServices, "installScriptService", {
      get() {
        throw new Error("RegistrationFixtureError");
      },
    });

    await assert.rejects(buildApp(services, { createFastify: () => app }), /RegistrationFixtureError/);
    assert.equal(close.mock.callCount(), 1);
  });
});

describe("partial startup cleanup", () => {
  it("keeps MongoDB open through T+22 after a prerequisite rejection or genuine stall", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(console, "error", () => {});
    for (const failure of ["reject", "stall"] as const) {
      const events: string[] = [];
      const stalled = deferred<void>();
      let now = 0;
      let cleanupResult: number | null = null;
      const cleanup = cleanupPartialStartup(
        partialResources(
          events,
          failure === "reject" ? Promise.reject(new Error("PRIVATE_CLOSE_FAILURE")) : stalled.promise,
        ),
        { now: () => now },
      );
      void cleanup.then((result) => {
        cleanupResult = result;
      });
      now = SHUTDOWN_HARD_DEADLINE_MS - 1;
      t.mock.timers.tick(SHUTDOWN_HARD_DEADLINE_MS - 1);
      await flushMicrotasks();
      assert.deepEqual(
        [cleanupResult, events.includes("app.force"), events.includes("db.close")],
        [null, true, false],
        failure,
      );

      now = SHUTDOWN_HARD_DEADLINE_MS;
      t.mock.timers.tick(1);
      assert.deepEqual([await cleanup, events.includes("db.close")], [1, false], failure);
    }
  });

  it("closes MongoDB last when force fencing unblocks every partial cleanup drain", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events: string[] = [];
    const appClose = deferred<void>();
    let now = 0;
    const cleanup = cleanupPartialStartup(
      partialResources(events, appClose.promise, () => appClose.resolve()),
      { now: () => now },
    );

    now = SHUTDOWN_DRAIN_DEADLINE_MS;
    t.mock.timers.tick(SHUTDOWN_DRAIN_DEADLINE_MS);
    assert.equal(await cleanup, 0);
    assert.deepEqual(events, ["app.close", "app.force", "db.close"]);
  });
});

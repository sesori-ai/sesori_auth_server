import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { MongoClient } from "mongodb";
import { MongoDbConnector } from "../src/db/mongo-db-connector.js";
import type { AppServices } from "../src/server.js";
import { buildApp } from "../src/server.js";
import { SHUTDOWN_DRAIN_DEADLINE_MS, SHUTDOWN_HARD_DEADLINE_MS, createShutdownCoordinator } from "../src/shutdown.js";
import type { ProductionRuntime, SignalTarget } from "../src/index.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createRuntime(events: string[], startFails = false): ProductionRuntime {
  const record = (event: string) => (): void => {
    events.push(event);
  };
  const recordAsync = (event: string) => async (): Promise<void> => {
    events.push(event);
  };
  return {
    app: {
      close: recordAsync("app.close"),
      server: { closeAllConnections: record("app.force") },
    },
    bridgeStateTracker: {
      dispose: recordAsync("bridge.dispose"),
      forceFence: record("bridge.force"),
    },
    activationReminderService: {
      start: () => {
        events.push("activation.start");
        if (startFails) {
          throw new Error("PRIVATE_START_FAILURE");
        }
      },
      dispose: recordAsync("activation.dispose"),
      forceFence: record("activation.force"),
    },
    dbConnector: { close: recordAsync("db.close") },
  } as unknown as ProductionRuntime;
}

function createHarness(synchronousFailure?: "app" | "bridge" | "activation") {
  const events: string[] = [];
  const exits: number[] = [];
  const drains = { app: deferred<void>(), bridge: deferred<void>(), activation: deferred<void>() };
  const drain = (stage: keyof typeof drains) => () => {
    events.push(`${stage}.${stage === "app" ? "close" : "dispose"}`);
    if (synchronousFailure === stage) {
      throw new Error("PRIVATE_SYNC_FAILURE");
    }

    return drains[stage].promise;
  };
  const coordinator = createShutdownCoordinator({
    app: {
      close: drain("app"),
      closeAllConnections: () => events.push("app.force"),
    },
    bridgeStateTracker: {
      dispose: drain("bridge"),
      forceFence: () => events.push("bridge.force"),
    },
    activationReminderService: {
      dispose: drain("activation"),
      forceFence: () => events.push("activation.force"),
    },
    dbConnector: { close: async () => void events.push("db.close") },
    selectExit: (code) => exits.push(code),
  });
  return { events, exits, drains, coordinator };
}

describe("shutdown coordinator", () => {
  it("memoizes duplicate signals and closes MongoDB only after every drain fulfills", async () => {
    const harness = createHarness();
    const first = harness.coordinator.shutdown("SIGTERM");
    const second = harness.coordinator.shutdown("SIGINT");
    assert.equal(first, second);
    assert.deepEqual(harness.events, ["bridge.dispose", "activation.dispose", "app.close"]);

    for (const drain of Object.values(harness.drains)) {
      drain.resolve();
    }

    assert.equal(await first, 0);
    assert.equal(harness.events.at(-1), "db.close");
    assert.deepEqual(harness.exits, [0]);
  });

  it("keeps MongoDB open until hard exit after every pre-drain throw or rejection", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const failedStage of ["app", "bridge", "activation"] as const) {
      for (const synchronous of [false, true]) {
        const harness = createHarness(synchronous ? failedStage : undefined);
        const shutdown = harness.coordinator.shutdown("SIGTERM");
        if (!synchronous) {
          harness.drains[failedStage].reject(new Error("PRIVATE_FAILURE"));
        }
        await flushMicrotasks();
        assert.equal(harness.events.includes("db.close"), false, failedStage);
        assert.deepEqual(harness.exits, []);

        t.mock.timers.tick(SHUTDOWN_HARD_DEADLINE_MS);
        assert.equal(await shutdown, 1);
        assert.deepEqual(harness.exits, [1]);
      }
    }
  });

  it("force-fences at T+15 but never closes MongoDB even after late drains settle", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const harness = createHarness();
    const shutdown = harness.coordinator.shutdown("SIGTERM");

    t.mock.timers.tick(SHUTDOWN_DRAIN_DEADLINE_MS);
    await flushMicrotasks();
    assert.deepEqual(harness.events.slice(-3), ["bridge.force", "activation.force", "app.force"]);
    assert.equal(harness.events.includes("db.close"), false);

    for (const drain of Object.values(harness.drains)) {
      drain.resolve();
    }
    await flushMicrotasks();
    assert.equal(harness.events.includes("db.close"), false);

    t.mock.timers.tick(SHUTDOWN_HARD_DEADLINE_MS - SHUTDOWN_DRAIN_DEADLINE_MS);
    assert.equal(await shutdown, 1);
    assert.deepEqual(harness.exits, [1]);
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
      app: { close: async () => {}, closeAllConnections: () => {} },
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
    const before = { sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") };
    const { main } = await import("../src/index.js");
    assert.deepEqual({ sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") }, before);

    const target = new EventEmitter();
    const events: string[] = [];
    const exits: number[] = [];
    const runtime = createRuntime(events);
    const handle = await main({
      startRuntime: async () => runtime,
      signalTarget: target as SignalTarget,
      selectExit: (code) => exits.push(code),
    });
    assert.equal(target.listenerCount("SIGINT"), 1);
    assert.equal(target.listenerCount("SIGTERM"), 1);

    target.emit("SIGINT");
    target.emit("SIGTERM");
    await handle.shutdownCoordinator.shutdown("SIGTERM");
    assert.deepEqual(exits, [0]);
    assert.equal(events.filter((event) => event === "db.close").length, 1);
    assert.equal(target.listenerCount("SIGINT"), 1);

    handle.removeSignalHandlers();
    handle.removeSignalHandlers();
    assert.equal(target.listenerCount("SIGINT"), 0);
    assert.equal(target.listenerCount("SIGTERM"), 0);
  });

  it("removes attempted listeners and cleans DB-last after post-composition startup failures", async () => {
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
        { name: "ProductionStartupError", message: "ProductionStartupError" },
      );

      assert.equal(emitter.listenerCount("SIGINT"), 0, failure);
      assert.equal(emitter.listenerCount("SIGTERM"), 0, failure);
      assert.deepEqual(
        events.filter((event) => event.endsWith(".force")),
        ["bridge.force", "activation.force"],
      );
      assert.equal(events.at(-1), "db.close", failure);
    }
  });

  it("buildApp closes its owned Fastify instance before rethrowing registration failure", async (t) => {
    const app = Fastify({ disableRequestLogging: true });
    let closed = false;
    const originalClose = app.close.bind(app);
    t.mock.method(app, "close", async () => {
      await originalClose();
      closed = true;
    });
    const services = Object.defineProperty({} as AppServices, "installScriptService", {
      get() {
        throw new Error("RegistrationFixtureError");
      },
    });

    await assert.rejects(buildApp(services, { createFastify: () => app }), /RegistrationFixtureError/);
    assert.equal(closed, true);
  });
});

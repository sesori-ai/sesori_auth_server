import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import Fastify from "fastify";
import type { AppServices } from "../src/server.js";
import { buildApp } from "../src/server.js";
import {
  SHUTDOWN_DRAIN_DEADLINE_MS,
  SHUTDOWN_HARD_DEADLINE_MS,
  cleanupPartialStartup,
  createShutdownCoordinator,
  type ShutdownTimers,
} from "../src/shutdown.js";
import type { MainHandle, ProductionRuntime, SignalTarget } from "../src/index.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type TestTimer = {
  at: number;
  callback: () => void;
  unref: () => void;
};

class TestTimers implements ShutdownTimers {
  #now = 0;
  readonly #timers = new Set<TestTimer>();

  setTimeout = (callback: () => void, delayMs: number): TestTimer => {
    const timer = { at: this.#now + delayMs, callback, unref: () => undefined };
    this.#timers.add(timer);
    return timer;
  };

  clearTimeout = (handle: { unref?: () => unknown }): void => {
    this.#timers.delete(handle as TestTimer);
  };

  advance(delayMs: number): void {
    const target = this.#now + delayMs;
    while (true) {
      const next = [...this.#timers].sort((left, right) => left.at - right.at)[0];
      if (!next || next.at > target) {
        break;
      }

      this.#timers.delete(next);
      this.#now = next.at;
      next.callback();
    }
    this.#now = target;
  }
}

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

function createHarness(synchronousFailure?: "app" | "bridge" | "activation") {
  const timers = new TestTimers();
  const events: string[] = [];
  const exits: number[] = [];
  const appClose = deferred<void>();
  const bridgeDrain = deferred<void>();
  const activationDrain = deferred<void>();
  const dbClose = deferred<void>();
  const coordinator = createShutdownCoordinator({
    app: {
      close: () => {
        events.push("app.close");
        if (synchronousFailure === "app") {
          throw new Error("PRIVATE_SYNC_FAILURE");
        }
        return appClose.promise;
      },
      closeAllConnections: () => events.push("app.force"),
    },
    bridgeStateTracker: {
      dispose: () => {
        events.push("bridge.dispose");
        if (synchronousFailure === "bridge") {
          throw new Error("PRIVATE_SYNC_FAILURE");
        }
        return bridgeDrain.promise;
      },
      forceFence: () => events.push("bridge.force"),
    },
    activationReminderService: {
      dispose: () => {
        events.push("activation.dispose");
        if (synchronousFailure === "activation") {
          throw new Error("PRIVATE_SYNC_FAILURE");
        }
        return activationDrain.promise;
      },
      forceFence: () => events.push("activation.force"),
    },
    dbConnector: {
      close: () => {
        events.push("db.close");
        return dbClose.promise;
      },
    },
    selectExit: (code) => exits.push(code),
    timers,
  });
  return { timers, events, exits, appClose, bridgeDrain, activationDrain, dbClose, coordinator };
}

describe("shutdown coordinator", () => {
  it("memoizes duplicate signals and closes MongoDB only after every drain fulfills", async () => {
    const harness = createHarness();
    const first = harness.coordinator.shutdown("SIGTERM");
    const second = harness.coordinator.shutdown("SIGINT");
    assert.equal(first, second);
    assert.deepEqual(harness.events, ["bridge.dispose", "activation.dispose", "app.close"]);

    harness.appClose.resolve();
    harness.bridgeDrain.resolve();
    harness.activationDrain.resolve();
    await flushMicrotasks();
    assert.equal(harness.events.at(-1), "db.close");
    harness.dbClose.resolve();

    assert.equal(await first, 0);
    assert.deepEqual(harness.exits, [0]);
  });

  it("keeps MongoDB open until hard exit after every pre-drain throw or rejection", async () => {
    for (const [failedStage, synchronous] of [
      ["app", false],
      ["bridge", false],
      ["activation", false],
      ["app", true],
      ["bridge", true],
      ["activation", true],
    ] as const) {
      const harness = createHarness(synchronous ? failedStage : undefined);
      const shutdown = harness.coordinator.shutdown("SIGTERM");
      if (!synchronous) {
        harness[
          failedStage === "app" ? "appClose" : failedStage === "bridge" ? "bridgeDrain" : "activationDrain"
        ].reject(new Error("PRIVATE_FAILURE"));
      }
      await flushMicrotasks();
      assert.equal(harness.events.includes("db.close"), false, failedStage);
      assert.deepEqual(harness.exits, []);

      harness.timers.advance(SHUTDOWN_HARD_DEADLINE_MS);
      assert.equal(await shutdown, 1);
      assert.deepEqual(harness.exits, [1]);
      assert.equal(harness.events.includes("db.close"), false, failedStage);
    }
  });

  it("force-fences at T+15 but never closes MongoDB even after late drains settle", async () => {
    const harness = createHarness();
    const shutdown = harness.coordinator.shutdown("SIGTERM");

    harness.timers.advance(SHUTDOWN_DRAIN_DEADLINE_MS);
    await flushMicrotasks();
    assert.deepEqual(harness.events.slice(-3), ["bridge.force", "activation.force", "app.force"]);
    assert.equal(harness.events.includes("db.close"), false);

    harness.appClose.resolve();
    harness.bridgeDrain.resolve();
    harness.activationDrain.resolve();
    await flushMicrotasks();
    assert.equal(harness.events.includes("db.close"), false);

    harness.timers.advance(SHUTDOWN_HARD_DEADLINE_MS - SHUTDOWN_DRAIN_DEADLINE_MS);
    assert.equal(await shutdown, 1);
    assert.deepEqual(harness.exits, [1]);
  });

  it("returns exit 1 when MongoDB close rejects after a successful drain", async () => {
    const harness = createHarness();
    const shutdown = harness.coordinator.shutdown("SIGTERM");
    harness.appClose.resolve();
    harness.bridgeDrain.resolve();
    harness.activationDrain.resolve();
    await flushMicrotasks();
    harness.dbClose.reject(new Error("PRIVATE_DATABASE_FAILURE"));

    assert.equal(await shutdown, 1);
    assert.deepEqual(harness.exits, [1]);
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
    const runtime = {
      app: {
        close: async () => events.push("app.close"),
        server: { closeAllConnections: () => events.push("app.force") },
      },
      bridgeStateTracker: {
        dispose: async () => events.push("bridge.dispose"),
        forceFence: () => events.push("bridge.force"),
      },
      activationReminderService: {
        start: () => events.push("activation.start"),
        dispose: async () => events.push("activation.dispose"),
        forceFence: () => events.push("activation.force"),
      },
      dbConnector: { close: async () => events.push("db.close") },
    } as unknown as ProductionRuntime;
    const handle: MainHandle = await main({
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

  it("cleans a partially started runtime in producer-before-MongoDB order", async () => {
    const events: string[] = [];
    await cleanupPartialStartup({
      app: { close: async () => events.push("app.close") },
      bridgeStateTracker: {
        forceFence: () => events.push("bridge.force"),
        dispose: async () => events.push("bridge.dispose"),
      },
      activationReminderService: {
        forceFence: () => events.push("activation.force"),
        dispose: async () => events.push("activation.dispose"),
      },
      dbConnector: { close: async () => events.push("db.close") },
    });

    assert.deepEqual(events.slice(0, 2), ["bridge.force", "activation.force"]);
    assert.equal(events.at(-1), "db.close");
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

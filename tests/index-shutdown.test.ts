import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { createShutdownHandler, type ShutdownWaiterOwner } from "../src/shutdown.js";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
};

describe("shutdown coordinator", () => {
  afterEach(() => {
    mock.timers.reset();
  });

  it("runs one ordered shutdown path and closes Mongo after waiter drains", async () => {
    const calls: string[] = [];
    const waiter = createWaiter(calls);
    const shutdown = createShutdownHandler({
      app: {
        close: async (): Promise<void> => {
          calls.push("app.close");
        },
      },
      mongo: {
        close: async () => {
          calls.push("mongo.close");
        },
      },
      waiters: [waiter],
      producers: [
        {
          dispose: async () => {
            calls.push("producer.dispose");
          },
        },
      ],
      realtimeService: {
        beginShutdown: () => calls.push("realtime.begin"),
        dispose: async () => {
          calls.push("realtime.dispose");
        },
      },
      exit: (code) => calls.push(`exit:${code}`),
      log: () => undefined,
    });

    await shutdown("SIGTERM");

    assert.deepEqual(calls, [
      "waiter.release",
      "realtime.begin",
      "producer.dispose",
      "realtime.dispose",
      "app.close",
      "waiter.drain",
      "mongo.close",
      "exit:0",
    ]);
  });

  it("reuses the same shutdown promise for repeated signals", async () => {
    const closeGate = deferred<void>();
    const calls: string[] = [];
    const shutdown = createShutdownHandler({
      app: {
        close: async (): Promise<void> => {
          calls.push("app.close");
          await closeGate.promise;
        },
      },
      mongo: {
        close: async () => {
          calls.push("mongo.close");
        },
      },
      waiters: [createWaiter(calls)],
      producers: [],
      realtimeService: null,
      exit: (code) => calls.push(`exit:${code}`),
      log: () => undefined,
    });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    assert.equal(first, second);
    closeGate.resolve();
    await first;

    assert.equal(calls.filter((call) => call === "app.close").length, 1);
    assert.equal(calls.filter((call) => call === "mongo.close").length, 1);
    assert.equal(calls.filter((call) => call === "exit:0").length, 1);
  });

  it("finishes realtime disposal before app.close so terminal frames flush to open sockets", async () => {
    const calls: string[] = [];
    const disposeGate = deferred<void>();
    const shutdown = createShutdownHandler({
      app: {
        close: async (): Promise<void> => {
          calls.push("app.close");
        },
      },
      mongo: {
        close: async () => {
          calls.push("mongo.close");
        },
      },
      waiters: [createWaiter(calls)],
      producers: [],
      realtimeService: {
        beginShutdown: () => calls.push("realtime.begin"),
        dispose: async () => {
          calls.push("realtime.dispose.start");
          await disposeGate.promise;
          calls.push("realtime.dispose.done");
        },
      },
      exit: (code) => calls.push(`exit:${code}`),
      log: () => undefined,
    });

    const running = shutdown("SIGTERM");
    await nextTurn();
    // @fastify/websocket's preClose closes every client socket, so app.close()
    // must not begin while a session is still emitting its terminal frame.
    assert.equal(calls.includes("app.close"), false);

    disposeGate.resolve(undefined);
    await running;

    assert.deepEqual(calls, [
      "waiter.release",
      "realtime.begin",
      "realtime.dispose.start",
      "realtime.dispose.done",
      "app.close",
      "waiter.drain",
      "mongo.close",
      "exit:0",
    ]);
  });

  it("treats a failed producer or realtime drain as degraded, still closing Mongo and exiting 0", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const shutdown = createShutdownHandler({
      app: {
        close: async (): Promise<void> => {
          calls.push("app.close");
        },
      },
      mongo: {
        close: async () => {
          calls.push("mongo.close");
        },
      },
      waiters: [createWaiter(calls)],
      producers: [
        {
          dispose: async () => {
            calls.push("producer.reject");
            throw new Error("reject failed");
          },
        },
        {
          dispose: () => {
            calls.push("producer.throw");
            throw new Error("throw failed");
          },
        },
      ],
      realtimeService: {
        beginShutdown: () => calls.push("realtime.begin"),
        dispose: () => {
          calls.push("realtime.dispose");
          throw new Error("realtime failed");
        },
      },
      exit: (code) => calls.push(`exit:${code}`),
      log: (message) => logs.push(message),
    });

    await shutdown("SIGTERM");

    assert.equal(calls.includes("producer.reject"), true);
    assert.equal(calls.includes("producer.throw"), true);
    assert.equal(calls.includes("realtime.dispose"), true);
    assert.equal(calls.includes("app.close"), true);
    // A drain that did not finish is loud but not a failed termination: the
    // work it guards is killed by process exit either way, so reporting exit 1
    // would turn every routine SIGTERM mid-sweep into a failed container stop.
    assert.equal(calls.includes("mongo.close"), true);
    assert.equal(calls.at(-1), "exit:0");
    assert.equal(logs.filter((message) => message === "[Shutdown] disposal degraded").length, 3);
  });

  it("exits 1 and skips Mongo when a resource-owning step rejects", async () => {
    const calls: string[] = [];
    const shutdown = createShutdownHandler({
      app: {
        close: async (): Promise<void> => {
          calls.push("app.close");
          throw new Error("app close failed");
        },
      },
      mongo: {
        close: async () => {
          calls.push("mongo.close");
        },
      },
      waiters: [createWaiter(calls)],
      producers: [],
      realtimeService: null,
      exit: (code) => calls.push(`exit:${code}`),
      log: () => undefined,
    });

    await shutdown("SIGTERM");

    assert.equal(calls.includes("mongo.close"), false);
    assert.equal(calls.at(-1), "exit:1");
  });

  it("hard deadline exits 1 once and skips Mongo while work remains pending", async () => {
    const calls: string[] = [];
    const pending = deferred<undefined>();
    const shutdown = createShutdownHandler({
      app: { close: async (): Promise<void> => pending.promise },
      mongo: {
        close: async () => {
          calls.push("mongo.close");
        },
      },
      waiters: [createWaiter(calls)],
      producers: [],
      realtimeService: null,
      exit: (code) => calls.push(`exit:${code}`),
      deadlineMs: 5,
      log: () => undefined,
    });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    await keepProcessAlive(first);
    await keepProcessAlive(second);

    assert.equal(calls.includes("mongo.close"), false);
    assert.deepEqual(
      calls.filter((call) => call.startsWith("exit:")),
      ["exit:1"],
    );
  });

  it("clears the hard deadline timer after successful completion", async () => {
    const calls: string[] = [];
    const deadlineTimers = createDeadlineTimers(calls);
    const shutdown = createShutdownHandler({
      app: {
        close: async (): Promise<void> => {
          calls.push("app.close");
        },
      },
      mongo: {
        close: async () => {
          calls.push("mongo.close");
        },
      },
      waiters: [createWaiter(calls)],
      producers: [],
      realtimeService: null,
      exit: (code) => calls.push(`exit:${code}`),
      deadlineMs: 5,
      deadlineTimers,
      log: () => undefined,
    });

    await shutdown("SIGTERM");

    assert.deepEqual(calls, [
      "waiter.release",
      "app.close",
      "deadline.set:5",
      "waiter.drain",
      "mongo.close",
      "deadline.clear",
      "exit:0",
    ]);
    assert.equal(deadlineTimers.activeCount(), 0);
  });
});

function createWaiter(calls: string[]): ShutdownWaiterOwner {
  return {
    releaseWaiters: () => calls.push("waiter.release"),
    drainReleasedReads: async () => {
      calls.push("waiter.drain");
    },
  };
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function keepProcessAlive<T>(promise: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type TestDeadlineTimer = {
  readonly callback: () => void;
  readonly milliseconds: number;
  active: boolean;
  clear(): void;
};

function createDeadlineTimers(calls: string[]) {
  const timers: TestDeadlineTimer[] = [];
  return {
    setTimeout: (callback: () => void, milliseconds: number): TestDeadlineTimer => {
      const timer = {
        callback,
        milliseconds,
        active: true,
        clear: (): void => {
          timer.active = false;
          calls.push("deadline.clear");
        },
      };
      timers.push(timer);
      calls.push(`deadline.set:${milliseconds}`);
      return timer;
    },
    activeCount: (): number => timers.filter((timer) => timer.active).length,
  };
}

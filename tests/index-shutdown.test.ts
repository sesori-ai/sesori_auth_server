import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createShutdownHandler, type ShutdownWaiterOwner } from "../src/shutdown.js";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
};

describe("shutdown coordinator", () => {
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

  it("exits 1 and skips Mongo when a prerequisite rejects", async () => {
    const calls: string[] = [];
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
            calls.push("producer.dispose");
            throw new Error("producer failed");
          },
        },
      ],
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
});

function createWaiter(calls: string[]): ShutdownWaiterOwner {
  return {
    releaseWaiters: () => calls.push("waiter.release"),
    drainReleasedReads: async () => {
      calls.push("waiter.drain");
    },
  };
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

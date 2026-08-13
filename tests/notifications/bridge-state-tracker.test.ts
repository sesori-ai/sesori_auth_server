import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { BridgeStatus } from "../../src/models/bridge.js";
import { NotificationCategory } from "../../src/models/notification.js";
import { BridgeStateTracker } from "../../src/services/bridge-state-tracker.js";
import type { NotificationPayload, NotificationService } from "../../src/services/notification-service.js";

type SendCall = {
  userId: string;
  payload: NotificationPayload;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const DEBOUNCE_MS = 120_000;
const HALF_DEBOUNCE_MS = DEBOUNCE_MS / 2;
const BRIDGE_ID = "br_bridge0001";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function connectedPayload(): NotificationPayload {
  return {
    category: NotificationCategory.ConnectionStatus,
    title: "Bridge Online",
    body: "Your bridge has reconnected.",
    collapseKey: "connection_status",
  };
}

function disconnectedPayload(): NotificationPayload {
  return {
    category: NotificationCategory.ConnectionStatus,
    title: "Bridge Offline",
    body: "Your bridge has disconnected. AI sessions are paused.",
    collapseKey: "connection_status",
  };
}

describe("BridgeStateTracker", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("default debounce waits two minutes before notifying", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);

    mock.timers.tick(HALF_DEBOUNCE_MS);
    await flushMicrotasks();

    assert.equal(sendCalls.length, 0);

    mock.timers.tick(HALF_DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: connectedPayload() }]);
  });

  it("stable connected notifies after debounce", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);

    mock.timers.tick(HALF_DEBOUNCE_MS);
    await flushMicrotasks();

    assert.equal(sendCalls.length, 0);

    mock.timers.tick(HALF_DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: connectedPayload() }]);
  });

  it("stable disconnected notifies after debounce", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.inactive);

    mock.timers.tick(HALF_DEBOUNCE_MS);
    await flushMicrotasks();

    assert.equal(sendCalls.length, 0);

    mock.timers.tick(HALF_DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: disconnectedPayload() }]);
  });

  it("flicker absorbed no notification", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(HALF_DEBOUNCE_MS);
    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.inactive);
    mock.timers.tick(HALF_DEBOUNCE_MS);
    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);

    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.equal(sendCalls.length, 1);
    assert.deepEqual(sendCalls[0], { userId: "user-1", payload: connectedPayload() });
  });

  it("rapid flicker only final state notifies", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(5_000);
    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.inactive);
    mock.timers.tick(5_000);
    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(5_000);
    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.inactive);

    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: disconnectedPayload() }]);
  });

  it("same status repeated timer not restarted", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(HALF_DEBOUNCE_MS);
    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(HALF_DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: connectedPayload() }]);
  });

  it("redundant after notification skipped", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: connectedPayload() }]);
  });

  it("multi-user isolation", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-a", BRIDGE_ID, BridgeStatus.active);
    tracker.handleStatusChangeForBridge("user-b", BRIDGE_ID, BridgeStatus.inactive);

    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [
      { userId: "user-a", payload: connectedPayload() },
      { userId: "user-b", payload: disconnectedPayload() },
    ]);
  });

  it("return-to-notified-state cancels silently", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.inactive);
    mock.timers.tick(HALF_DEBOUNCE_MS);
    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: connectedPayload() }]);
  });

  it("dispose clears all pending timers", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    tracker.handleStatusChangeForBridge("user-2", BRIDGE_ID, BridgeStatus.inactive);
    tracker.handleStatusChangeForBridge("user-3", BRIDGE_ID, BridgeStatus.active);
    await tracker.dispose();

    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.equal(sendCalls.length, 0);
  });

  it("cancelPendingForBridge clears only the targeted bridge timer", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", "br_target0001", BridgeStatus.inactive);
    tracker.handleStatusChangeForBridge("user-1", "br_other0001", BridgeStatus.active);
    tracker.cancelPendingForBridge("user-1", "br_target0001");

    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: connectedPayload() }]);
  });

  it("notification payload correctness", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    tracker.handleStatusChangeForBridge("user-2", BRIDGE_ID, BridgeStatus.inactive);
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [
      { userId: "user-1", payload: connectedPayload() },
      { userId: "user-2", payload: disconnectedPayload() },
    ]);
  });

  it("sendToUser rejection is caught and new status change still works", async () => {
    const sendCalls: SendCall[] = [];
    let shouldReject = true;
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        if (shouldReject) {
          throw new Error("send failed");
        }

        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    shouldReject = false;
    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.inactive);
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [
      { userId: "user-1", payload: connectedPayload() },
      { userId: "user-1", payload: disconnectedPayload() },
    ]);
  });

  it("stale async completion does not overwrite newer state", async () => {
    const sendCalls: SendCall[] = [];
    const firstSend = createDeferred<{ devicesNotified: number }>();
    let invocation = 0;
    const notificationServiceMock = {
      sendToUser: (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        invocation += 1;

        if (invocation === 1) {
          return firstSend.promise;
        }

        return Promise.resolve({ devicesNotified: 1 });
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.inactive);
    firstSend.resolve({ devicesNotified: 1 });
    await flushMicrotasks();

    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [
      { userId: "user-1", payload: connectedPayload() },
      { userId: "user-1", payload: disconnectedPayload() },
    ]);
  });

  it("dispose waits for an already-fired notification callback", async () => {
    const sendDeferred = createDeferred<{ devicesNotified: number }>();
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return sendDeferred.promise;
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    let disposed = false;
    const disposing = tracker.dispose().then(() => {
      disposed = true;
    });
    await flushMicrotasks();
    assert.equal(disposed, false);

    sendDeferred.resolve({ devicesNotified: 1 });
    await disposing;
    assert.equal(disposed, true);
    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: connectedPayload() }]);
  });

  it("dispose rejects when an already-fired notification callback does not drain", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sendDeferred = createDeferred<{ devicesNotified: number }>();
    const notificationServiceMock = {
      sendToUser: () => sendDeferred.promise,
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, 1);

    tracker.handleStatusChangeForBridge("user-1", BRIDGE_ID, BridgeStatus.active);
    t.mock.timers.tick(1);
    await flushMicrotasks();

    const disposing = tracker.dispose();
    t.mock.timers.tick(15_000);

    await assert.rejects(disposing, /bridge state tracker drain timed out/);
  });

  it("dispose is idempotent", async () => {
    const notificationServiceMock = {
      sendToUser: async () => ({ devicesNotified: 1 }),
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS);

    await tracker.dispose();

    await tracker.dispose();
  });
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { BridgeConnectionNotificationPolicy, BridgeStatus } from "../../src/models/bridge.js";
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
const BRIDGE_NAME = "dev-laptop";

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

function connectedPayload(bridgeId = BRIDGE_ID): NotificationPayload {
  return {
    category: NotificationCategory.ConnectionStatus,
    title: "dev-laptop is online",
    body: "Your computer has reconnected.",
    collapseKey: "connection_status",
    trayKey: `connection_status:${bridgeId}`,
    excludedDeviceIds: new Set<string>(),
  };
}

function disconnectedPayload(bridgeId = BRIDGE_ID): NotificationPayload {
  return {
    category: NotificationCategory.ConnectionStatus,
    title: "dev-laptop went offline",
    body: "AI sessions there are paused.",
    collapseKey: "connection_status",
    trayKey: `connection_status:${bridgeId}`,
    excludedDeviceIds: new Set<string>(),
  };
}

async function markOfflineNotified(args: {
  tracker: BridgeStateTracker;
  sendCalls: SendCall[];
  userId?: string;
  bridgeId?: string;
}): Promise<void> {
  args.tracker.handleStatusChangeForBridge({
    userId: args.userId ?? "user-1",
    bridgeId: args.bridgeId ?? BRIDGE_ID,
    bridgeName: BRIDGE_NAME,
    status: BridgeStatus.inactive,
    notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
    connectionId: null,
  });
  mock.timers.tick(DEBOUNCE_MS);
  await flushMicrotasks();
  args.sendCalls.length = 0;
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
    const tracker = new BridgeStateTracker({ notificationService: notificationServiceMock });

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });

    mock.timers.tick(HALF_DEBOUNCE_MS);
    await flushMicrotasks();

    assert.equal(sendCalls.length, 0);

    mock.timers.tick(HALF_DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: disconnectedPayload() }]);
  });

  it("stable connected notifies after debounce", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    await markOfflineNotified({ tracker, sendCalls });
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });

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
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });

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
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(HALF_DEBOUNCE_MS);
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(HALF_DEBOUNCE_MS);
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });

    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, []);
  });

  it("rapid flicker only final state notifies", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(5_000);
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(5_000);
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(5_000);
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });

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
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(HALF_DEBOUNCE_MS);
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(HALF_DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: disconnectedPayload() }]);
  });

  it("redundant after notification skipped", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: disconnectedPayload() }]);
  });

  it("multi-user isolation", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    await markOfflineNotified({ tracker, sendCalls, userId: "user-a" });
    tracker.handleStatusChangeForBridge({
      userId: "user-a",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    tracker.handleStatusChangeForBridge({
      userId: "user-b",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });

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
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    await markOfflineNotified({ tracker, sendCalls });
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(HALF_DEBOUNCE_MS);
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
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
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    tracker.handleStatusChangeForBridge({
      userId: "user-2",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    tracker.handleStatusChangeForBridge({
      userId: "user-3",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
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
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: "br_target0001",
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: "br_other0001",
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    tracker.cancelPendingForBridge("user-1", "br_target0001");

    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: disconnectedPayload("br_other0001") }]);
  });

  it("notification payload correctness", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    await markOfflineNotified({ tracker, sendCalls });
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    tracker.handleStatusChangeForBridge({
      userId: "user-2",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [
      { userId: "user-1", payload: connectedPayload() },
      { userId: "user-2", payload: disconnectedPayload() },
    ]);
  });

  it("names each computer and keys its push per bridge", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    await markOfflineNotified({ tracker, sendCalls, bridgeId: "br_laptop0001" });
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: "br_laptop0001",
      bridgeName: "dev-laptop",
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: "br_desktop001",
      bridgeName: "build-box",
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(
      sendCalls.map(({ payload }) => [
        payload.title,
        payload.body,
        payload.collapseKey,
        payload.category === NotificationCategory.ConnectionStatus ? payload.trayKey : null,
      ]),
      [
        [
          "dev-laptop is online",
          "Your computer has reconnected.",
          "connection_status",
          "connection_status:br_laptop0001",
        ],
        [
          "build-box went offline",
          "AI sessions there are paused.",
          "connection_status",
          "connection_status:br_desktop001",
        ],
      ],
    );
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
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    shouldReject = false;
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, [
      { userId: "user-1", payload: disconnectedPayload() },
      { userId: "user-1", payload: connectedPayload() },
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

        if (invocation === 2) {
          return firstSend.promise;
        }

        return Promise.resolve({ devicesNotified: 1 });
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    await markOfflineNotified({ tracker, sendCalls });
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    mock.timers.tick(DEBOUNCE_MS);

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
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
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
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
    assert.deepEqual(sendCalls, [{ userId: "user-1", payload: disconnectedPayload() }]);
  });

  it("dispose rejects when an already-fired notification callback does not drain", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sendDeferred = createDeferred<{ devicesNotified: number }>();
    const notificationServiceMock = {
      sendToUser: () => sendDeferred.promise,
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker({ notificationService: notificationServiceMock, conservativeDelayMs: 1 });

    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    t.mock.timers.tick(1);
    await flushMicrotasks();

    const disposing = tracker.dispose();
    t.mock.timers.tick(15_000);

    await assert.rejects(disposing, /bridge state tracker drain timed out/);
  });

  // Idempotent means one drain, not two that happen to both succeed: a repeated
  // SIGTERM must reuse the in-flight disposal rather than start a second one.
  it("dispose is idempotent", async () => {
    const notificationServiceMock = {
      sendToUser: async () => ({ devicesNotified: 1 }),
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    const first = tracker.dispose();
    const second = tracker.dispose();

    assert.equal(first, second);
    await first;
    assert.equal(tracker.dispose(), first);
  });

  // The post-dispose gates on the two public entry points are the only thing
  // stopping a late relay status report from arming a timer after shutdown has
  // already cleared them — that timer would fire into a closed process and, on
  // the way, push a notification for a bridge nobody is watching any more.
  it("ignores status changes and cancellations submitted after dispose", async () => {
    const sendCalls: SendCall[] = [];
    const notificationServiceMock = {
      sendToUser: async (userId: string, payload: NotificationPayload) => {
        sendCalls.push({ userId, payload });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    const tracker = new BridgeStateTracker({
      notificationService: notificationServiceMock,
      conservativeDelayMs: DEBOUNCE_MS,
    });

    await tracker.dispose();
    tracker.handleStatusChangeForBridge({
      userId: "user-1",
      bridgeId: BRIDGE_ID,
      bridgeName: BRIDGE_NAME,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId: null,
    });
    tracker.cancelPendingForBridge("user-1", BRIDGE_ID);
    mock.timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.deepEqual(sendCalls, []);
  });

  describe("an online push only answers an offline push", () => {
    const NEW_CONNECTION_ID = "0123456789abcdef0123456789abcdef";

    function createRecordingTracker(): { tracker: BridgeStateTracker; sendCalls: SendCall[] } {
      const sendCalls: SendCall[] = [];
      const notificationServiceMock = {
        sendToUser: async (userId: string, payload: NotificationPayload) => {
          sendCalls.push({ userId, payload });
          return { devicesNotified: 1 };
        },
      } as unknown as NotificationService;
      return { tracker: new BridgeStateTracker({ notificationService: notificationServiceMock }), sendCalls };
    }

    it("a restart inside the offline debounce sends nothing", async () => {
      const { tracker, sendCalls } = createRecordingTracker();

      tracker.handleStatusChangeForBridge({
        userId: "user-1",
        bridgeId: BRIDGE_ID,
        bridgeName: BRIDGE_NAME,
        status: BridgeStatus.inactive,
        notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
        connectionId: null,
      });
      mock.timers.tick(10_000);
      tracker.handleStatusChangeForBridge({
        userId: "user-1",
        bridgeId: BRIDGE_ID,
        bridgeName: BRIDGE_NAME,
        status: BridgeStatus.active,
        notificationPolicy: BridgeConnectionNotificationPolicy.Normal,
        connectionId: NEW_CONNECTION_ID,
      });
      mock.timers.tick(DEBOUNCE_MS * 2);
      await flushMicrotasks();

      assert.deepEqual(sendCalls, []);
    });

    it("a same-socket policy report on a fresh tracker sends nothing", async () => {
      const { tracker, sendCalls } = createRecordingTracker();

      tracker.handleStatusChangeForBridge({
        userId: "user-1",
        bridgeId: BRIDGE_ID,
        bridgeName: BRIDGE_NAME,
        status: BridgeStatus.active,
        notificationPolicy: BridgeConnectionNotificationPolicy.Normal,
        connectionId: NEW_CONNECTION_ID,
      });
      mock.timers.tick(DEBOUNCE_MS * 2);
      await flushMicrotasks();

      assert.deepEqual(sendCalls, []);
    });

    it("a reconnect after a delivered offline push notifies after five seconds", async () => {
      const { tracker, sendCalls } = createRecordingTracker();

      tracker.handleStatusChangeForBridge({
        userId: "user-1",
        bridgeId: BRIDGE_ID,
        bridgeName: BRIDGE_NAME,
        status: BridgeStatus.inactive,
        notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
        connectionId: null,
      });
      mock.timers.tick(DEBOUNCE_MS);
      await flushMicrotasks();
      assert.deepEqual(sendCalls, [{ userId: "user-1", payload: disconnectedPayload() }]);

      tracker.handleStatusChangeForBridge({
        userId: "user-1",
        bridgeId: BRIDGE_ID,
        bridgeName: BRIDGE_NAME,
        status: BridgeStatus.active,
        notificationPolicy: BridgeConnectionNotificationPolicy.Normal,
        connectionId: NEW_CONNECTION_ID,
      });
      mock.timers.tick(4_999);
      await flushMicrotasks();
      assert.equal(sendCalls.length, 1);

      mock.timers.tick(1);
      await flushMicrotasks();
      assert.deepEqual(sendCalls, [
        { userId: "user-1", payload: disconnectedPayload() },
        { userId: "user-1", payload: connectedPayload() },
      ]);
    });

    it("a computer that drops again before its online push repeats no offline push", async () => {
      const { tracker, sendCalls } = createRecordingTracker();
      await markOfflineNotified({ tracker, sendCalls });
      const report = {
        userId: "user-1",
        bridgeId: BRIDGE_ID,
        bridgeName: BRIDGE_NAME,
        connectionId: NEW_CONNECTION_ID,
      };

      tracker.handleStatusChangeForBridge({
        ...report,
        status: BridgeStatus.active,
        notificationPolicy: BridgeConnectionNotificationPolicy.Normal,
      });
      mock.timers.tick(1_000);
      tracker.handleStatusChangeForBridge({
        ...report,
        status: BridgeStatus.inactive,
        notificationPolicy: BridgeConnectionNotificationPolicy.Normal,
      });
      mock.timers.tick(DEBOUNCE_MS * 2);
      await flushMicrotasks();

      assert.deepEqual(sendCalls, []);
    });

    it("a reconnect while the offline push is still sending gets its online push", async () => {
      const send = createDeferred<{ devicesNotified: number }>();
      const sendCalls: SendCall[] = [];
      const tracker = new BridgeStateTracker({
        notificationService: {
          sendToUser: async (userId: string, payload: NotificationPayload) => {
            sendCalls.push({ userId, payload });
            return sendCalls.length === 1 ? send.promise : { devicesNotified: 1 };
          },
        } as unknown as NotificationService,
      });
      const report = { userId: "user-1", bridgeId: BRIDGE_ID, bridgeName: BRIDGE_NAME };

      tracker.handleStatusChangeForBridge({
        ...report,
        status: BridgeStatus.inactive,
        notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
        connectionId: null,
      });
      mock.timers.tick(DEBOUNCE_MS);
      await flushMicrotasks();
      tracker.handleStatusChangeForBridge({
        ...report,
        status: BridgeStatus.active,
        notificationPolicy: BridgeConnectionNotificationPolicy.Normal,
        connectionId: NEW_CONNECTION_ID,
      });
      send.resolve({ devicesNotified: 1 });
      await flushMicrotasks();
      mock.timers.tick(5_000);
      await flushMicrotasks();

      assert.deepEqual(sendCalls, [
        { userId: "user-1", payload: disconnectedPayload() },
        { userId: "user-1", payload: connectedPayload() },
      ]);
    });
  });
});

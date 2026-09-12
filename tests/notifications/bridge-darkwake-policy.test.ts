import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { BridgeConnectionNotificationPolicy, BridgeStatus } from "../../src/models/bridge.js";
import { BridgeStateTracker } from "../../src/services/bridge-state-tracker.js";
import type { NotificationPayload, NotificationService } from "../../src/services/notification-service.js";

const bridgeId = "br_bridge0001";
const connectionId = "0123456789abcdef0123456789abcdef";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("BridgeStateTracker DarkWake policy", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("suppresses a sleep-only episode without clearing a genuine pending offline", async () => {
    const calls: NotificationPayload[] = [];
    const notificationService = {
      sendToUser: async (_: string, payload: NotificationPayload) => {
        calls.push(payload);
        return { devicesNotified: 1, retryableFailures: 0 };
      },
    } as NotificationService;
    const tracker = new BridgeStateTracker({ notificationService, conservativeDelayMs: 100, normalOnlineDelayMs: 5 });
    tracker.handleStatusChangeForBridge({
      userId: "u",
      bridgeId,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Normal,
      connectionId,
    });
    mock.timers.tick(5);
    await flush();
    tracker.handleStatusChangeForBridge({
      userId: "u",
      bridgeId,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Conservative,
      connectionId,
    });
    tracker.handleStatusChangeForBridge({
      userId: "u",
      bridgeId,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Suppress,
      connectionId: "1123456789abcdef0123456789abcdef",
    });
    tracker.handleStatusChangeForBridge({
      userId: "u",
      bridgeId,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Suppress,
      connectionId: "1123456789abcdef0123456789abcdef",
    });
    mock.timers.tick(100);
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].title, "Bridge Offline");
  });

  it("keeps a DarkWake-only suppress connection episode quiet", async () => {
    const calls: NotificationPayload[] = [];
    const notificationService = {
      sendToUser: async (_: string, payload: NotificationPayload) => {
        calls.push(payload);
        return { devicesNotified: 1, retryableFailures: 0 };
      },
    } as NotificationService;
    const tracker = new BridgeStateTracker({ notificationService, conservativeDelayMs: 100, normalOnlineDelayMs: 5 });
    tracker.handleStatusChangeForBridge({
      userId: "u",
      bridgeId,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Suppress,
      connectionId,
    });
    tracker.handleStatusChangeForBridge({
      userId: "u",
      bridgeId,
      status: BridgeStatus.inactive,
      notificationPolicy: BridgeConnectionNotificationPolicy.Suppress,
      connectionId,
    });

    mock.timers.tick(100);
    await flush();

    assert.deepEqual(calls, []);
  });

  it("buffers exact-device observation when relay delivery beats connected status", async () => {
    const calls: NotificationPayload[] = [];
    const notificationService = {
      sendToUser: async (_: string, payload: NotificationPayload) => {
        calls.push(payload);
        return { devicesNotified: 1, retryableFailures: 0 };
      },
    } as NotificationService;
    const tracker = new BridgeStateTracker({ notificationService, conservativeDelayMs: 100, normalOnlineDelayMs: 5 });
    tracker.markConnectionObserved({
      userId: "u",
      bridgeId,
      connectionId,
      deviceId: "123e4567-e89b-42d3-a456-426614174000",
    });
    tracker.handleStatusChangeForBridge({
      userId: "u",
      bridgeId,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Normal,
      connectionId,
    });

    mock.timers.tick(5);
    await flush();

    assert.equal(calls.length, 1);
    const payload = calls[0];
    assert.equal(payload.category, "connection_status");
    if (payload.category === "connection_status")
      assert.deepEqual([...payload.excludedDeviceIds], ["123e4567-e89b-42d3-a456-426614174000"]);
  });

  it("full wake on the same socket schedules fast online and exact-device exclusion", async () => {
    const calls: NotificationPayload[] = [];
    const notificationService = {
      sendToUser: async (_: string, payload: NotificationPayload) => {
        calls.push(payload);
        return { devicesNotified: 1, retryableFailures: 0 };
      },
    } as NotificationService;
    const tracker = new BridgeStateTracker({ notificationService, conservativeDelayMs: 100, normalOnlineDelayMs: 5 });
    tracker.handleStatusChangeForBridge({
      userId: "u",
      bridgeId,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Suppress,
      connectionId,
    });
    tracker.handleStatusChangeForBridge({
      userId: "u",
      bridgeId,
      status: BridgeStatus.active,
      notificationPolicy: BridgeConnectionNotificationPolicy.Normal,
      connectionId,
    });
    tracker.markConnectionObserved({
      userId: "u",
      bridgeId,
      connectionId,
      deviceId: "123e4567-e89b-42d3-a456-426614174000",
    });
    mock.timers.tick(5);
    await flush();
    assert.equal(calls.length, 1);
    const payload = calls[0];
    assert.equal(payload.category, "connection_status");
    if (payload.category === "connection_status")
      assert.deepEqual([...payload.excludedDeviceIds], ["123e4567-e89b-42d3-a456-426614174000"]);
  });
});

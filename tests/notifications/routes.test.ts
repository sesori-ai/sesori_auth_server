import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { DeviceTokenRepository } from "../../src/repositories/device-token-repo.js";
import type { BridgeStateTracker } from "../../src/services/bridge-state-tracker.js";
import type { NotificationService } from "../../src/services/notification-service.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

type SendCall = {
  userId: string;
  payload: unknown;
};

type TrackerCall = {
  userId: string;
  bridgeId?: string;
  status: string;
};

function hasProjectId(payload: unknown): payload is { data: { projectId: string } } {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    return false;
  }
  const data = payload.data;
  return typeof data === "object" && data !== null && "projectId" in data && typeof data.projectId === "string";
}

describe("Notification routes", () => {
  let ctx: TestContext;
  let deviceTokenRepo: DeviceTokenRepository;
  const sendCalls: SendCall[] = [];
  const trackerCalls: TrackerCall[] = [];

  const notificationServiceMock = {
    sendToUser: async (userId: string, payload: unknown) => {
      sendCalls.push({ userId, payload });
      return { devicesNotified: 2 };
    },
  } as unknown as NotificationService;

  const bridgeStateTrackerMock = {
    handleStatusChange: (userId: string, status: string) => {
      trackerCalls.push({ userId, status });
    },
    handleStatusChangeForBridge: (userId: string, bridgeId: string, status: string) => {
      trackerCalls.push({ userId, bridgeId, status });
    },
    cancelPendingForBridge: () => {},
    dispose: () => {},
  } as unknown as BridgeStateTracker;

  before(async () => {
    ctx = await createTestApp({
      notificationService: notificationServiceMock,
      bridgeStateTracker: bridgeStateTrackerMock,
    });
    deviceTokenRepo = new DeviceTokenRepository(ctx.dbAccessor);
  });

  beforeEach(() => {
    sendCalls.length = 0;
    trackerCalls.length = 0;
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("POST /notifications/register-token returns 200 with valid body and auth", async () => {
    const user = await ctx.createUser();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/notifications/register-token",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ token: "fcm-token-1", platform: "ios" }),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });

    const tokens = await deviceTokenRepo.findByUserId(user.userId);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]?.token, "fcm-token-1");
    assert.equal(tokens[0]?.platform, "ios");
  });

  it("POST /notifications/register-token returns 401 without auth", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/notifications/register-token",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ token: "fcm-token-2", platform: "android" }),
    });

    assert.equal(res.statusCode, 401);
  });

  it("POST /notifications/register-token returns 400 with invalid platform", async () => {
    const user = await ctx.createUser();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/notifications/register-token",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ token: "fcm-token-3", platform: "web" }),
    });

    assert.equal(res.statusCode, 400);
  });

  it("DELETE /notifications/tokens/:token returns 200 with auth", async () => {
    const user = await ctx.createUser();
    const token = "token/with:special?chars";
    await deviceTokenRepo.upsertToken(user.userId, token, "android");

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/notifications/tokens/${encodeURIComponent(token)}`,
      headers: {
        authorization: `Bearer ${user.accessToken}`,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    const tokens = await deviceTokenRepo.findByUserId(user.userId);
    assert.equal(tokens.length, 0);
  });

  it("POST /notifications/send returns 200 and calls notificationService.sendToUser", async () => {
    const user = await ctx.createUser();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/notifications/send",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        category: "ai_interaction",
        title: "Need your input",
        body: "The assistant is waiting for confirmation.",
        collapseKey: "ai_interaction",
        data: {
          category: "ai_interaction",
          eventType: "question_asked",
          sessionId: "abc123",
          projectId: "/Users/alexandrudochioiu/sesori-ai/sesori_apps_monorepo",
        },
      }),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, devicesNotified: 2 });
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.userId, user.userId);
    assert.ok(hasProjectId(sendCalls[0]?.payload));
    assert.equal(sendCalls[0].payload.data.projectId, "/Users/alexandrudochioiu/sesori-ai/sesori_apps_monorepo");
  });

  it("POST /notifications/send returns 400 with invalid category", async () => {
    const user = await ctx.createUser();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/notifications/send",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        category: "connection_status",
        title: "Bridge status",
        body: "Not allowed on this endpoint",
      }),
    });

    assert.equal(res.statusCode, 400);
  });

  it("POST /notifications/send returns 401 without auth", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/notifications/send",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        category: "ai_interaction",
        title: "Need your input",
        body: "The assistant is waiting for confirmation.",
      }),
    });

    assert.equal(res.statusCode, 401);
  });

  it("POST /internal/bridge-status (disconnected) returns 200 with valid relay secret", async () => {
    const user = await ctx.createUser();
    await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Legacy Bridge", platform: "macos" }),
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-status",
      headers: {
        "x-relay-secret": "test-relay-secret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        userId: user.userId,
        status: "disconnected",
        timestamp: new Date().toISOString(),
      }),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(trackerCalls.length, 1);
    assert.equal(trackerCalls[0]?.userId, user.userId);
    assert.equal(trackerCalls[0]?.status, "inactive");
  });

  it("POST /internal/bridge-status (connected) delegates to bridgeStateTracker", async () => {
    const user = await ctx.createUser();
    await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Legacy Bridge", platform: "macos" }),
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-status",
      headers: {
        "x-relay-secret": "test-relay-secret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        userId: user.userId,
        status: "connected",
        timestamp: new Date().toISOString(),
      }),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(trackerCalls.length, 1);
    assert.equal(trackerCalls[0]?.userId, user.userId);
    assert.equal(trackerCalls[0]?.status, "active");
  });

  it("POST /internal/bridge-status ignores legacy status when user has no bridges", async () => {
    const user = await ctx.createUser();
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Deleted", platform: "macos" }),
    });
    const bridge = createRes.json<{ id: string }>();
    await ctx.app.inject({
      method: "DELETE",
      url: `/auth/bridges/${encodeURIComponent(bridge.id)}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-status",
      headers: {
        "x-relay-secret": "test-relay-secret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        userId: user.userId,
        status: "connected",
        timestamp: new Date().toISOString(),
      }),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(trackerCalls.length, 0);
  });

  it("POST /internal/bridge-status returns 401 with missing or wrong secret", async () => {
    const user = await ctx.createUser();

    const payload = JSON.stringify({
      userId: user.userId,
      status: "connected",
      timestamp: new Date().toISOString(),
    });

    const missingSecretRes = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-status",
      headers: {
        "content-type": "application/json",
      },
      payload,
    });
    assert.equal(missingSecretRes.statusCode, 401);

    const wrongSecretRes = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-status",
      headers: {
        "x-relay-secret": "wrong-secret",
        "content-type": "application/json",
      },
      payload,
    });
    assert.equal(wrongSecretRes.statusCode, 401);
  });

  it("POST /internal/bridge-status returns 400 with invalid status", async () => {
    const user = await ctx.createUser();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-status",
      headers: {
        "x-relay-secret": "test-relay-secret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        userId: user.userId,
        status: "unknown",
        timestamp: new Date().toISOString(),
      }),
    });

    assert.equal(res.statusCode, 400);
  });

  it("POST /internal/bridge-status returns 400 with invalid timestamp", async () => {
    const user = await ctx.createUser();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-status",
      headers: {
        "x-relay-secret": "test-relay-secret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        userId: user.userId,
        status: "connected",
        timestamp: "not-a-date",
      }),
    });

    assert.equal(res.statusCode, 400);
  });

  it("POST /internal/bridge-status updates active non-revoked bridge and notifies per bridge", async () => {
    const user = await ctx.createUser();
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Mac", platform: "macos" }),
    });
    const bridge = createRes.json<{ id: string }>();
    const timestamp = "2026-06-08T10:00:00.000Z";

    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-status",
      headers: {
        "x-relay-secret": "test-relay-secret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        userId: user.userId,
        bridgeId: bridge.id,
        status: "connected",
        timestamp,
      }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(trackerCalls.length, 1);
    assert.equal(trackerCalls[0]?.userId, user.userId);
    assert.equal(trackerCalls[0]?.bridgeId, bridge.id);
    assert.equal(trackerCalls[0]?.status, "active");

    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const list = listRes.json<{ bridges: { id: string; status: string; lastSeenAt: string | null }[] }>();
    assert.equal(list.bridges[0]?.id, bridge.id);
    assert.equal(list.bridges[0]?.status, "active");
    assert.equal(list.bridges[0]?.lastSeenAt, timestamp);
  });

  it("POST /internal/bridge-status heartbeats update lastSeenAt without notifying again", async () => {
    const user = await ctx.createUser();
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Mac", platform: "macos" }),
    });
    const bridge = createRes.json<{ id: string }>();

    for (const timestamp of ["2026-06-08T10:00:00.000Z", "2026-06-08T10:01:00.000Z"]) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/internal/bridge-status",
        headers: {
          "x-relay-secret": "test-relay-secret",
          "content-type": "application/json",
        },
        payload: JSON.stringify({
          userId: user.userId,
          bridgeId: bridge.id,
          status: "connected",
          timestamp,
        }),
      });
      assert.equal(res.statusCode, 200);
    }

    assert.equal(trackerCalls.length, 1);
    assert.equal(trackerCalls[0]?.status, "active");

    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const list = listRes.json<{ bridges: { lastSeenAt: string | null }[] }>();
    assert.equal(list.bridges[0]?.lastSeenAt, "2026-06-08T10:01:00.000Z");
  });

  it("POST /internal/bridge-status ignores stale per-bridge events", async () => {
    const user = await ctx.createUser();
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Mac", platform: "macos" }),
    });
    const bridge = createRes.json<{ id: string }>();

    for (const event of [
      { status: "connected", timestamp: "2026-06-08T10:01:00.000Z" },
      { status: "disconnected", timestamp: "2026-06-08T10:00:00.000Z" },
    ]) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/internal/bridge-status",
        headers: {
          "x-relay-secret": "test-relay-secret",
          "content-type": "application/json",
        },
        payload: JSON.stringify({
          userId: user.userId,
          bridgeId: bridge.id,
          status: event.status,
          timestamp: event.timestamp,
        }),
      });
      assert.equal(res.statusCode, 200);
    }

    assert.equal(trackerCalls.length, 1);
    assert.equal(trackerCalls[0]?.status, "active");

    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const list = listRes.json<{ bridges: { status: string; lastSeenAt: string | null }[] }>();
    assert.equal(list.bridges[0]?.status, "active");
    assert.equal(list.bridges[0]?.lastSeenAt, "2026-06-08T10:01:00.000Z");
  });

  it("POST /internal/bridge-status rejects revoked bridge IDs", async () => {
    const user = await ctx.createUser();
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Deleted", platform: "macos" }),
    });
    const bridge = createRes.json<{ id: string }>();
    const deleteRes = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/bridges/${encodeURIComponent(bridge.id)}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(deleteRes.statusCode, 200);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-status",
      headers: {
        "x-relay-secret": "test-relay-secret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        userId: user.userId,
        bridgeId: bridge.id,
        status: "connected",
        timestamp: new Date().toISOString(),
      }),
    });

    assert.equal(res.statusCode, 404);
    assert.equal(trackerCalls.length, 0);
  });
});

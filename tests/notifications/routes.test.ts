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
  status: string;
};

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
        data: { category: "ai_interaction", eventType: "question_asked", sessionId: "abc123" },
      }),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, devicesNotified: 2 });
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.userId, user.userId);
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
    assert.equal(trackerCalls[0]?.status, "disconnected");
  });

  it("POST /internal/bridge-status (connected) delegates to bridgeStateTracker", async () => {
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
        timestamp: new Date().toISOString(),
      }),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(trackerCalls.length, 1);
    assert.equal(trackerCalls[0]?.userId, user.userId);
    assert.equal(trackerCalls[0]?.status, "connected");
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
});

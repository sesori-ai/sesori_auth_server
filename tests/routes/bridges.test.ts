import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { BridgeStateTracker } from "../../src/services/bridge-state-tracker.js";
import type { NotificationService } from "../../src/services/notification-service.js";

type BridgeSummaryBody = {
  id: string;
  name: string;
  addedAt: string;
  lastSeenAt: string | null;
  platform: "macos" | "windows" | "linux";
};

describe("/auth/bridges routes", () => {
  let ctx: TestContext;
  const cancelledLegacyUsers: string[] = [];
  const cancelledBridgeKeys: { userId: string; bridgeId: string }[] = [];

  const bridgeStateTrackerMock = {
    handleStatusChange: () => {},
    handleStatusChangeForBridge: () => {},
    cancelPendingForUser: (userId: string) => {
      cancelledLegacyUsers.push(userId);
    },
    cancelPendingForBridge: (userId: string, bridgeId: string) => {
      cancelledBridgeKeys.push({ userId, bridgeId });
    },
    dispose: () => {},
  } as unknown as BridgeStateTracker;

  before(async () => {
    ctx = await createTestApp({ bridgeStateTracker: bridgeStateTrackerMock });
  });

  after(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    cancelledLegacyUsers.length = 0;
    cancelledBridgeKeys.length = 0;
  });

  async function registerBridge(accessToken: string, payload: { name: string; platform: string; bridgeId?: string }) {
    return ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(payload),
    });
  }

  it("POST /auth/bridges returns 201 with the bridge summary", async () => {
    const user = await ctx.createUser();

    const res = await registerBridge(user.accessToken, { name: "Alex's MacBook Pro", platform: "macos" });

    assert.equal(res.statusCode, 201);
    const body = res.json<BridgeSummaryBody>();
    assert.match(body.id, /^br_[A-Za-z0-9_-]{8,32}$/);
    assert.equal(body.name, "Alex's MacBook Pro");
    assert.equal(body.lastSeenAt, null);
    assert.equal(body.platform, "macos");
    assert.ok(typeof body.addedAt === "string");
    assert.ok(!("status" in body), "status must not leak into the API");
    assert.ok(!("bridgeToken" in body), "bridgeToken must not exist in the API");
  });

  it("POST /auth/bridges with an owned bridgeId updates it in place and returns 200", async () => {
    const user = await ctx.createUser();
    const createRes = await registerBridge(user.accessToken, { name: "Old Name", platform: "macos" });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.json<BridgeSummaryBody>();

    const updateRes = await registerBridge(user.accessToken, {
      name: "New Name",
      platform: "linux",
      bridgeId: created.id,
    });

    assert.equal(updateRes.statusCode, 200);
    const updated = updateRes.json<BridgeSummaryBody>();
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "New Name");
    assert.equal(updated.platform, "linux");
    assert.equal(updated.addedAt, created.addedAt);

    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const list = listRes.json<{ bridges: BridgeSummaryBody[] }>();
    assert.equal(list.bridges.length, 1);
    assert.equal(list.bridges[0]?.name, "New Name");
  });

  it("POST /auth/bridges with an unknown bridgeId mints a new bridge and returns 201", async () => {
    const user = await ctx.createUser();

    const res = await registerBridge(user.accessToken, {
      name: "Fresh",
      platform: "macos",
      bridgeId: "br_doesNotExist00",
    });

    assert.equal(res.statusCode, 201);
    const body = res.json<BridgeSummaryBody>();
    assert.notEqual(body.id, "br_doesNotExist00");
    assert.match(body.id, /^br_[A-Za-z0-9_-]{8,32}$/);
  });

  it("POST /auth/bridges with a revoked bridgeId mints a new bridge and returns 201", async () => {
    const user = await ctx.createUser();
    const createRes = await registerBridge(user.accessToken, { name: "Doomed", platform: "macos" });
    const created = createRes.json<BridgeSummaryBody>();

    const deleteRes = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/bridges/${encodeURIComponent(created.id)}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(deleteRes.statusCode, 200);

    const res = await registerBridge(user.accessToken, {
      name: "Replacement",
      platform: "macos",
      bridgeId: created.id,
    });

    assert.equal(res.statusCode, 201);
    const body = res.json<BridgeSummaryBody>();
    assert.notEqual(body.id, created.id);
  });

  it("POST /auth/bridges with another user's bridgeId mints a new bridge and leaves theirs untouched", async () => {
    const owner = await ctx.createUser();
    const stranger = await ctx.createUser();
    const ownerRes = await registerBridge(owner.accessToken, { name: "Owner's Bridge", platform: "macos" });
    const ownerBridge = ownerRes.json<BridgeSummaryBody>();

    const res = await registerBridge(stranger.accessToken, {
      name: "Hijack Attempt",
      platform: "linux",
      bridgeId: ownerBridge.id,
    });

    assert.equal(res.statusCode, 201);
    const body = res.json<BridgeSummaryBody>();
    assert.notEqual(body.id, ownerBridge.id);

    const ownerListRes = await ctx.app.inject({
      method: "GET",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const ownerList = ownerListRes.json<{ bridges: BridgeSummaryBody[] }>();
    assert.equal(ownerList.bridges.length, 1);
    assert.equal(ownerList.bridges[0]?.name, "Owner's Bridge");
    assert.equal(ownerList.bridges[0]?.platform, "macos");
  });

  it("POST /auth/bridges returns 400 on malformed bridgeId", async () => {
    const user = await ctx.createUser();
    const res = await registerBridge(user.accessToken, {
      name: "X",
      platform: "macos",
      bridgeId: "not-a-bridge-id",
    });
    assert.equal(res.statusCode, 400);
  });

  it("POST /auth/bridges returns 400 on invalid platform", async () => {
    const user = await ctx.createUser();
    const res = await registerBridge(user.accessToken, { name: "X", platform: "beos" });
    assert.equal(res.statusCode, 400);
  });

  it("POST /auth/bridges returns 400 on empty name", async () => {
    const user = await ctx.createUser();
    const res = await registerBridge(user.accessToken, { name: "", platform: "macos" });
    assert.equal(res.statusCode, 400);
  });

  it("POST /auth/bridges returns 401 without auth", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "X", platform: "macos" }),
    });
    assert.equal(res.statusCode, 401);
  });

  it("GET /auth/bridges returns empty array for new user", async () => {
    const user = await ctx.createUser();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ bridges: unknown[] }>();
    assert.deepEqual(body.bridges, []);
  });

  it("GET /auth/bridges returns the registered bridges", async () => {
    const user = await ctx.createUser();

    // Register two bridges
    for (const name of ["Mac", "Linux Box"]) {
      await registerBridge(user.accessToken, { name, platform: "macos" });
    }

    const res = await ctx.app.inject({
      method: "GET",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ bridges: { name: string; platform: string }[] }>();
    assert.equal(body.bridges.length, 2);
    const names = body.bridges.map((b) => b.name);
    assert.ok(names.includes("Mac"));
    assert.ok(names.includes("Linux Box"));
  });

  it("DELETE /auth/bridges/:bridgeId soft-revokes the bridge", async () => {
    const user = await ctx.createUser();
    const createRes = await registerBridge(user.accessToken, { name: "Doomed", platform: "macos" });
    const created = createRes.json<{ id: string }>();

    const delRes = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/bridges/${encodeURIComponent(created.id)}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(delRes.statusCode, 200);
    assert.deepEqual(delRes.json(), { ok: true });

    // After revoke, the list should be empty
    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const body = listRes.json<{ bridges: unknown[] }>();
    assert.deepEqual(body.bridges, []);
    assert.deepEqual(cancelledBridgeKeys, [{ userId: user.userId, bridgeId: created.id }]);
    // The legacy (user-level) timer tracks unregistered legacy bridges and is
    // deliberately untouched by per-bridge revocation.
    assert.deepEqual(cancelledLegacyUsers, []);
  });

  it("DELETE /auth/bridges/:bridgeId returns 404 for non-owner", async () => {
    const owner = await ctx.createUser();
    const stranger = await ctx.createUser();

    const createRes = await registerBridge(owner.accessToken, { name: "Owner's Bridge", platform: "macos" });
    const created = createRes.json<{ id: string }>();

    const delRes = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/bridges/${encodeURIComponent(created.id)}`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    assert.equal(delRes.statusCode, 404);
  });

  it("DELETE /auth/bridges/:bridgeId returns 400 for invalid bridgeId format", async () => {
    const user = await ctx.createUser();
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/auth/bridges/not-a-bridge-id",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(res.statusCode, 400);
  });

  it("DELETE /auth/bridges/:bridgeId returns 404 on second revoke (already revoked)", async () => {
    const user = await ctx.createUser();
    const createRes = await registerBridge(user.accessToken, { name: "Bridge", platform: "macos" });
    const created = createRes.json<{ id: string }>();

    const first = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/bridges/${encodeURIComponent(created.id)}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(first.statusCode, 200);

    const second = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/bridges/${encodeURIComponent(created.id)}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(second.statusCode, 404);
  });

  it("POST /auth/bridges caps non-revoked bridges per user at 50", async () => {
    const user = await ctx.createUser();

    for (let i = 0; i < 50; i++) {
      const res = await registerBridge(user.accessToken, { name: `Bridge ${i}`, platform: "linux" });
      assert.equal(res.statusCode, 201);
    }

    const over = await registerBridge(user.accessToken, { name: "One too many", platform: "linux" });
    assert.equal(over.statusCode, 400);

    // Idempotent re-registration of an existing bridge still works at the cap.
    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const existing = listRes.json<{ bridges: { id: string }[] }>().bridges[0];
    const update = await registerBridge(user.accessToken, {
      name: "Renamed",
      platform: "linux",
      bridgeId: existing.id,
    });
    assert.equal(update.statusCode, 200);
  });

  it("POST /auth/bridges holds the cap under concurrent registration bursts", async () => {
    const user = await ctx.createUser();

    for (let i = 0; i < 49; i++) {
      const res = await registerBridge(user.accessToken, { name: `Bridge ${i}`, platform: "linux" });
      assert.equal(res.statusCode, 201);
    }

    await Promise.all(
      Array.from({ length: 4 }, (_, i) => registerBridge(user.accessToken, { name: `Burst ${i}`, platform: "linux" })),
    );

    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const { bridges } = listRes.json<{ bridges: { id: string }[] }>();
    assert.ok(bridges.length <= 50, `expected at most 50 non-revoked bridges, got ${bridges.length}`);
  });
});

describe("bridge revocation cancels pending notifications (end to end)", () => {
  let ctx: TestContext;
  const sentNotifications: { userId: string }[] = [];
  const DEBOUNCE_MS = 50;

  before(async () => {
    const notificationServiceMock = {
      sendToUser: async (userId: string) => {
        sentNotifications.push({ userId });
        return { devicesNotified: 1 };
      },
    } as unknown as NotificationService;
    ctx = await createTestApp({
      notificationService: notificationServiceMock,
      bridgeStateTracker: new BridgeStateTracker(notificationServiceMock, DEBOUNCE_MS),
    });
  });

  after(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    sentNotifications.length = 0;
  });

  it("register -> status change -> DELETE -> debounce elapses -> no notification fires", async () => {
    const user = await ctx.createUser();
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Doomed", platform: "macos" }),
    });
    const created = createRes.json<{ id: string }>();

    const statusRes = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-status",
      headers: { "x-relay-secret": "test-relay-secret", "content-type": "application/json" },
      payload: JSON.stringify({
        userId: user.userId,
        bridgeId: created.id,
        status: "connected",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(statusRes.statusCode, 200);

    const delRes = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/bridges/${encodeURIComponent(created.id)}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(delRes.statusCode, 200);

    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 3));
    assert.deepEqual(sentNotifications, [], "revoked bridge must not fire its pending notification");
  });

  it("control: without the DELETE the debounced notification does fire", async () => {
    const user = await ctx.createUser();
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Alive", platform: "macos" }),
    });
    const created = createRes.json<{ id: string }>();

    const statusRes = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-status",
      headers: { "x-relay-secret": "test-relay-secret", "content-type": "application/json" },
      payload: JSON.stringify({
        userId: user.userId,
        bridgeId: created.id,
        status: "connected",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(statusRes.statusCode, 200);

    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 3));
    assert.deepEqual(sentNotifications, [{ userId: user.userId }]);
  });
});

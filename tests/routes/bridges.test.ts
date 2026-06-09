import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { bridgeTokenPayloadSchema } from "../../src/models/jwt.js";
import type { BridgeStateTracker } from "../../src/services/bridge-state-tracker.js";

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

  it("POST /auth/bridges returns 201 with bridge summary and bridge-bound token", async () => {
    const user = await ctx.createUser();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Alex's MacBook Pro", platform: "macos" }),
    });

    assert.equal(res.statusCode, 201);
    const body = res.json<{
      id: string;
      name: string;
      status: "active" | "inactive";
      addedAt: string;
      lastSeenAt: string | null;
      platform: "macos" | "windows" | "linux";
      bridgeToken: string;
    }>();
    assert.match(body.id, /^br_[A-Za-z0-9_-]{8,32}$/);
    assert.equal(body.name, "Alex's MacBook Pro");
    assert.equal(body.status, "inactive");
    assert.equal(body.lastSeenAt, null);
    assert.equal(body.platform, "macos");
    assert.ok(typeof body.addedAt === "string");

    const tokenPayloadResult = bridgeTokenPayloadSchema.safeParse(ctx.tokenService.verifyBridgeToken(body.bridgeToken));
    assert.equal(tokenPayloadResult.success, true);
    if (!tokenPayloadResult.success) return;
    assert.equal(tokenPayloadResult.data.tokenType, "bridge");
    assert.equal(tokenPayloadResult.data.aud, "bridge");
    assert.equal(tokenPayloadResult.data.userId, user.userId);
    assert.equal(tokenPayloadResult.data.bridgeId, body.id);
  });

  it("POST /auth/bridges never mints malformed bridge tokens", async () => {
    const user = await ctx.createUser();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Alex's MacBook Pro", platform: "macos" }),
    });

    assert.equal(res.statusCode, 201);
    const body = res.json<{ id: string; bridgeToken: string }>();
    const tokenPayloadResult = bridgeTokenPayloadSchema.safeParse(ctx.tokenService.verifyBridgeToken(body.bridgeToken));
    assert.equal(tokenPayloadResult.success, true);
    if (!tokenPayloadResult.success) return;
    assert.match(tokenPayloadResult.data.bridgeId, /^br_[A-Za-z0-9_-]{8,32}$/);
    assert.equal(tokenPayloadResult.data.bridgeId, body.id);
  });

  it("POST /internal/bridge-token/validate accepts an active bridge token", async () => {
    const user = await ctx.createUser();
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Alex's MacBook Pro", platform: "macos" }),
    });
    assert.equal(createRes.statusCode, 201);
    const bridge = createRes.json<{ id: string; bridgeToken: string }>();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-token/validate",
      headers: {
        "x-relay-secret": "test-relay-secret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ userId: user.userId, bridgeId: bridge.id, bridgeToken: bridge.bridgeToken }),
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });

  it("POST /internal/bridge-token/validate rejects a token for a deleted bridge", async () => {
    const user = await ctx.createUser();
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Deleted Bridge", platform: "macos" }),
    });
    assert.equal(createRes.statusCode, 201);
    const bridge = createRes.json<{ id: string; bridgeToken: string }>();

    const deleteRes = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/bridges/${encodeURIComponent(bridge.id)}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(deleteRes.statusCode, 200);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-token/validate",
      headers: {
        "x-relay-secret": "test-relay-secret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ userId: user.userId, bridgeId: bridge.id, bridgeToken: bridge.bridgeToken }),
    });

    assert.equal(res.statusCode, 404);
  });

  it("POST /internal/bridge-token/validate rejects token subject mismatches", async () => {
    const user = await ctx.createUser();
    const firstRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "First", platform: "macos" }),
    });
    const secondRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Second", platform: "macos" }),
    });
    assert.equal(firstRes.statusCode, 201);
    assert.equal(secondRes.statusCode, 201);
    const first = firstRes.json<{ bridgeToken: string }>();
    const second = secondRes.json<{ id: string }>();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/bridge-token/validate",
      headers: {
        "x-relay-secret": "test-relay-secret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ userId: user.userId, bridgeId: second.id, bridgeToken: first.bridgeToken }),
    });

    assert.equal(res.statusCode, 401);
  });

  it("POST /auth/bridges returns 400 on invalid platform", async () => {
    const user = await ctx.createUser();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "X", platform: "beos" }),
    });
    assert.equal(res.statusCode, 400);
  });

  it("POST /auth/bridges returns 400 on empty name", async () => {
    const user = await ctx.createUser();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "", platform: "macos" }),
    });
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
      await ctx.app.inject({
        method: "POST",
        url: "/auth/bridges",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ name, platform: "macos" }),
      });
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
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Doomed", platform: "macos" }),
    });
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
    assert.deepEqual(cancelledLegacyUsers, [user.userId]);
  });

  it("DELETE /auth/bridges/:bridgeId returns 404 for non-owner", async () => {
    const owner = await ctx.createUser();
    const stranger = await ctx.createUser();

    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Owner's Bridge", platform: "macos" }),
    });
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
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Bridge", platform: "macos" }),
    });
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
});

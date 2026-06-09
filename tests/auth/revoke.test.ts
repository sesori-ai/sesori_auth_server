import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import type { BridgeSummary } from "../../src/models/api.js";
import type { BridgeRepository } from "../../src/repositories/bridge-repo.js";
import { BridgeService } from "../../src/services/bridge-service.js";
import type { BridgeStateTracker } from "../../src/services/bridge-state-tracker.js";

describe("POST /auth/revoke", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("returns { success: true } for an authenticated request", async () => {
    const user = await ctx.createUser();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/revoke",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { success: true });
  });

  it("returns 401 when called without authentication", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/revoke",
    });

    assert.equal(res.statusCode, 401);
  });

  it("invalidates old refresh token after revoke (tokenVersion incremented)", async () => {
    const user = await ctx.createUser();

    // Revoke the user
    const revokeRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/revoke",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(revokeRes.statusCode, 200);

    // Try to refresh with the old refresh token
    const refreshRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ refreshToken: user.refreshToken }),
    });

    assert.equal(refreshRes.statusCode, 401);
    assert.equal(refreshRes.json<{ error: string }>().error, "unauthenticated");
  });

  it("keeps auth tokens retryable when bridge revocation fails", async () => {
    const failingCtx = await createTestApp({ bridgeService: new FailingRevokeAllBridgeService() });
    try {
      const user = await failingCtx.createUser();

      const revokeRes = await failingCtx.app.inject({
        method: "POST",
        url: "/auth/revoke",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      assert.equal(revokeRes.statusCode, 500);

      const meRes = await failingCtx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      assert.equal(meRes.statusCode, 200);
      assert.equal(meRes.json<{ user: { id: string } }>().user.id, user.userId);
    } finally {
      await failingCtx.cleanup();
    }
  });

  it("revokes registered bridges after account token revocation", async () => {
    const user = await ctx.createUser();
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/bridges",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Compromised Bridge", platform: "macos" }),
    });
    assert.equal(createRes.statusCode, 201);
    const bridge = createRes.json<{ id: string }>();

    const revokeRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/revoke",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(revokeRes.statusCode, 200);

    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/auth/bridges",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(listRes.statusCode, 401);

    const statusRes = await ctx.app.inject({
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
    assert.equal(statusRes.statusCode, 404);
  });

  it("invalidates old access token after revoke", async () => {
    const user = await ctx.createUser();

    const revokeRes = await ctx.app.inject({
      method: "POST",
      url: "/auth/revoke",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(revokeRes.statusCode, 200);

    const meRes = await ctx.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(meRes.statusCode, 401);
  });
});

class FailingRevokeAllBridgeService extends BridgeService {
  constructor() {
    super({
      bridgeRepo: {} as BridgeRepository,
      bridgeStateTracker: {} as BridgeStateTracker,
    });
  }

  override async revokeAllForUser(_userId: string): Promise<void> {
    throw new Error("bridge revocation failed");
  }

  override async listForUser(_userId: string): Promise<BridgeSummary[]> {
    return [];
  }
}

describe("Bridge endpoint removal", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("bridge endpoints return 404 after removal", async () => {
    const user = await ctx.createUser();

    // Test POST /bridge/register
    const registerRes = await ctx.app.inject({
      method: "POST",
      url: "/bridge/register",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        relayUrl: "ws://localhost:8080",
        roomCode: "abcd-1234",
        publicKey: "test-key",
      }),
    });
    assert.equal(registerRes.statusCode, 404);

    // Test POST /bridge/heartbeat
    const heartbeatRes = await ctx.app.inject({
      method: "POST",
      url: "/bridge/heartbeat",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(heartbeatRes.statusCode, 404);

    // Test DELETE /bridge/deregister
    const deregisterRes = await ctx.app.inject({
      method: "DELETE",
      url: "/bridge/deregister",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(deregisterRes.statusCode, 404);

    // Test GET /bridge/mine
    const mineRes = await ctx.app.inject({
      method: "GET",
      url: "/bridge/mine",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(mineRes.statusCode, 404);
  });
});

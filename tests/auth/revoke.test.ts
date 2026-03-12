import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";

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
    assert.equal(refreshRes.json<{ error: string }>().error, "unauthorized");
  });
});

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

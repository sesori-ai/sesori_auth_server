import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { bridgeTokenPayloadSchema } from "../../src/models/jwt.js";

describe("/auth/bridges routes", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    // no state to reset
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

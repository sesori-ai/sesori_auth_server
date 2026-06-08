import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("Token routes", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  describe("GET /auth/public-key", () => {
    it("returns PEM public key with text/plain content-type", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/auth/public-key",
      });

      assert.equal(res.statusCode, 200);
      assert.ok(
        res.headers["content-type"]?.toString().includes("text/plain"),
        `Expected text/plain, got: ${res.headers["content-type"]}`,
      );
      assert.ok(res.payload.includes("-----BEGIN PUBLIC KEY-----"), "Response should contain PEM public key header");
    });
  });

  describe("POST /auth/refresh", () => {
    it("returns new access and refresh tokens for a valid refresh token", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken: user.refreshToken }),
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{
        accessToken: string;
        refreshToken: string;
        user: { id: string; provider: string };
      }>();
      assert.ok(body.accessToken, "Should return new accessToken");
      assert.ok(body.refreshToken, "Should return new refreshToken");
      assert.equal(body.user.id, user.userId);
      assert.equal(body.user.provider, user.provider);
    });

    it("returns 401 for an expired refresh token", async () => {
      const user = await ctx.createUser();
      const expiredToken = ctx.createExpiredRefreshToken(user.userId);

      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken: expiredToken }),
      });

      assert.equal(res.statusCode, 401);
      assert.equal(res.json<{ error: string }>().error, "unauthenticated");
    });

    it("returns 401 for a syntactically invalid token", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken: "not.a.valid.jwt" }),
      });

      assert.equal(res.statusCode, 401);
    });

    it("returns 401 for a valid-format token referencing a non-existent user", async () => {
      const ghostToken = ctx.tokenService.signRefreshToken({
        userId: "000000000000000000000000",
        tokenVersion: 0,
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken: ghostToken }),
      });

      assert.equal(res.statusCode, 401);
    });

    it("returns 401 for refresh after logout (tokenVersion incremented)", async () => {
      const user = await ctx.createUser();

      const logoutRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      assert.equal(logoutRes.statusCode, 200);

      const refreshRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken: user.refreshToken }),
      });

      assert.equal(refreshRes.statusCode, 401);
      assert.equal(refreshRes.json<{ error: string }>().error, "unauthenticated");
    });

    it("returns 400 when refreshToken field is missing from body", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({}),
      });

      assert.equal(res.statusCode, 400);
    });
  });

  describe("GET /auth/me", () => {
    it("returns user profile for a valid access token", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{
        user: { id: string; provider: string; providerUserId: string };
        bridges: unknown[];
      }>();
      assert.equal(body.user.id, user.userId);
      assert.equal(body.user.provider, user.provider);
      assert.equal(body.user.providerUserId, user.providerUserId);
      assert.deepEqual(body.bridges, []);
    });

    it("returns the registered bridges in the bridges array", async () => {
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
      const created = createRes.json<{ id: string; name: string }>();

      const res = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json<{
        bridges: { id: string; name: string; status: "active" | "inactive" }[];
      }>();
      assert.equal(body.bridges.length, 1);
      assert.equal(body.bridges[0]?.id, created.id);
      assert.equal(body.bridges[0]?.name, "Mac");
      assert.equal(body.bridges[0]?.status, "inactive");
    });

    it("returns 401 when no Authorization header is provided", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
      });

      assert.equal(res.statusCode, 401);
    });

    it("returns 401 for an invalid Bearer token", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: "Bearer totally.invalid.token" },
      });

      assert.equal(res.statusCode, 401);
    });

    it("returns 401 when Authorization header is missing Bearer prefix", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: user.accessToken }, // no "Bearer " prefix
      });

      assert.equal(res.statusCode, 401);
    });

    it("returns 401 for an expired access token on protected route", async () => {
      const user = await ctx.createUser();
      const expiredAccessToken = ctx.createExpiredAccessToken({
        userId: user.userId,
        provider: user.provider,
        providerUserId: user.providerUserId,
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${expiredAccessToken}` },
      });

      assert.equal(res.statusCode, 401);
      assert.equal(res.json<{ error: string }>().error, "unauthenticated");
    });

    it("returns 401 when access token has wrong audience", async () => {
      const user = await ctx.createUser();
      const bridgeToken = ctx.tokenService.signBridgeToken({ userId: user.userId, bridgeId: "br_testBridge01" });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${bridgeToken}` },
      });

      assert.equal(res.statusCode, 401);
      assert.equal(res.json<{ error: string }>().error, "unauthenticated");
    });

    it("returns 404 for /auth/me when access token user no longer exists", async () => {
      const ghostAccessToken = ctx.tokenService.signAccessToken({
        userId: "000000000000000000000000",
        provider: "github",
        providerUserId: "ghost-provider-user",
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${ghostAccessToken}` },
      });

      assert.equal(res.statusCode, 404);
      assert.equal(res.json<{ error: string }>().error, "not_found");
    });
  });

  describe("POST /auth/logout", () => {
    it("returns { success: true } for an authenticated request", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { success: true });
    });

    it("returns 401 when called without authentication", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/logout",
      });

      assert.equal(res.statusCode, 401);
    });
  });
});

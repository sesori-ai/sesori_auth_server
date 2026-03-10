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
        `Expected text/plain, got: ${res.headers["content-type"]}`
      );
      assert.ok(
        res.payload.includes("-----BEGIN PUBLIC KEY-----"),
        "Response should contain PEM public key header"
      );
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
      assert.equal(res.json<{ error: string }>().error, "unauthorized");
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
      // Sign a refresh token for a userId that doesn't exist in the DB
      const { signRefreshToken } = await import("../../src/auth/jwt.js");
      const ghostToken = signRefreshToken({
        userId: "000000000000000000000000",
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken: ghostToken }),
      });

      assert.equal(res.statusCode, 401);
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
      }>();
      assert.equal(body.user.id, user.userId);
      assert.equal(body.user.provider, user.provider);
      assert.equal(body.user.providerUserId, user.providerUserId);
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

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import argon2 from "argon2";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { MongoDbDatabase, AuthDbCollection } from "../../src/types/mongo.js";
import type { User, PasswordAccount } from "../../src/models/documents.js";

describe("Password authentication", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  async function createPasswordAccount(email: string, password: string): Promise<PasswordAccount> {
    const userCollection = ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
    const passwordCollection = ctx.dbAccessor.getCollection<PasswordAccount>(
      MongoDbDatabase.Auth,
      AuthDbCollection.PasswordAccounts,
    );

    const userId = new ObjectId();
    const now = new Date();
    await userCollection.insertOne({
      _id: userId,
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const passwordAccount: PasswordAccount = {
      _id: new ObjectId(),
      userId,
      email: email.toLowerCase(),
      passwordHash: hash,
      createdAt: now,
      updatedAt: now,
    };
    await passwordCollection.insertOne(passwordAccount);
    return passwordAccount;
  }

  describe("POST /auth/email", () => {
    it("returns tokens for valid credentials", async () => {
      const email = "test@example.com";
      const password = "correct-password-123";
      await createPasswordAccount(email, password);

      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email, password }),
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ accessToken: string; refreshToken: string; user: { id: string; provider: string } }>();
      assert.ok(body.accessToken, "Should return access token");
      assert.ok(body.refreshToken, "Should return refresh token");
      assert.ok(body.user.id, "Should return user id");
      assert.equal(body.user.provider, "email");
    });

    it("returns 401 for wrong password", async () => {
      const email = "wrongpass@example.com";
      const password = "correct-password";
      await createPasswordAccount(email, password);

      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email, password: "wrong-password" }),
      });

      assert.equal(res.statusCode, 401);
      assert.equal(res.json<{ error: string }>().error, "unauthenticated");
    });

    it("returns 401 for unknown email", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email: "notexist@example.com", password: "any-password" }),
      });

      assert.equal(res.statusCode, 401);
      assert.equal(res.json<{ error: string }>().error, "unauthenticated");
    });

    it("returns 401 for unknown email", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email: "notexist@example.com", password: "any-password" }),
      });

      assert.equal(res.statusCode, 401);
      assert.equal(res.json<{ error: string }>().error, "unauthenticated");
    });

    it("returns 400 for empty body", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({}),
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 for malformed email", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email: "not-an-email", password: "any-password" }),
      });

      assert.equal(res.statusCode, 400);
    });

    it.skip("returns 429 on 6th failed attempt (rate limiting)", async () => {
      const email = "ratelimit@example.com";
      await createPasswordAccount(email, "correct-password");

      for (let i = 0; i < 5; i++) {
        const res = await ctx.app.inject({
          method: "POST",
          url: "/auth/email",
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ email, password: "wrong-password" }),
        });
        assert.equal(res.statusCode, 401, `Attempt ${i + 1} should return 401`);
      }

      const sixthRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email, password: "wrong-password" }),
      });

      assert.equal(sixthRes.statusCode, 429);
    });
  });

  describe("POST /auth/refresh (password user)", () => {
    it("returns new tokens for valid refresh token", async () => {
      const email = "refresh@example.com";
      const password = "password123";
      await createPasswordAccount(email, password);

      const loginRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email, password }),
      });
      assert.equal(loginRes.statusCode, 200);
      const { refreshToken } = loginRes.json<{ refreshToken: string }>();

      const refreshRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken }),
      });

      assert.equal(refreshRes.statusCode, 200);
      const body = refreshRes.json<{
        accessToken: string;
        refreshToken: string;
        user: { id: string; provider: string };
      }>();
      assert.ok(body.accessToken);
      assert.ok(body.refreshToken);
      assert.equal(body.user.provider, "email");
    });
  });

  describe("GET /auth/me (password user)", () => {
    it("returns user profile with provider=pASSWORD", async () => {
      const email = "me@example.com";
      const password = "password456";
      await createPasswordAccount(email, password);

      const loginRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email, password }),
      });
      assert.equal(loginRes.statusCode, 200);
      const { accessToken } = loginRes.json<{ accessToken: string }>();

      const meRes = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${accessToken}` },
      });

      assert.equal(meRes.statusCode, 200);
      const body = meRes.json<{ user: { id: string; provider: string; providerUsername: string } }>();
      assert.equal(body.user.provider, "email");
      assert.equal(body.user.providerUsername, email.toLowerCase());
    });
  });

  describe("POST /auth/logout (password user)", () => {
    it("invalidates refresh token after logout", async () => {
      const email = "logout@example.com";
      const password = "password789";
      await createPasswordAccount(email, password);

      const loginRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email, password }),
      });
      assert.equal(loginRes.statusCode, 200);
      const { refreshToken } = loginRes.json<{ refreshToken: string }>();

      const logoutRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { authorization: `Bearer ${loginRes.json<{ accessToken: string }>().accessToken}` },
      });
      assert.equal(logoutRes.statusCode, 200);

      const refreshRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken }),
      });

      assert.equal(refreshRes.statusCode, 401);
    });
  });

  describe("POST /auth/revoke (password user)", () => {
    it("invalidates refresh token after revoke", async () => {
      const email = "revoke@example.com";
      const password = "password000";
      await createPasswordAccount(email, password);

      const loginRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email, password }),
      });
      assert.equal(loginRes.statusCode, 200);
      const { refreshToken } = loginRes.json<{ refreshToken: string }>();

      const revokeRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/revoke",
        headers: { authorization: `Bearer ${loginRes.json<{ accessToken: string }>().accessToken}` },
      });
      assert.equal(revokeRes.statusCode, 200);

      const refreshRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken }),
      });

      assert.equal(refreshRes.statusCode, 401);
    });
  });

  describe("Cross-method isolation", () => {
    it("OAuth and password user tokens do not interfere", async () => {
      const oauthUser = await ctx.createUser({ provider: "github", providerUserId: "github-123" });

      const passwordEmail = "cross-test@example.com";
      const passwordPassword = "password123";
      await createPasswordAccount(passwordEmail, passwordPassword);

      const passwordLoginRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email: passwordEmail, password: passwordPassword }),
      });
      assert.equal(passwordLoginRes.statusCode, 200);
      const passwordTokens = passwordLoginRes.json<{ accessToken: string; refreshToken: string }>();

      const oauthRefreshRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken: oauthUser.refreshToken }),
      });
      assert.equal(oauthRefreshRes.statusCode, 200);

      const passwordRefreshRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken: passwordTokens.refreshToken }),
      });
      assert.equal(passwordRefreshRes.statusCode, 200);

      const oauthMeRes = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${oauthUser.accessToken}` },
      });
      assert.equal(oauthMeRes.statusCode, 200);
      assert.equal(oauthMeRes.json<{ user: { provider: string } }>().user.provider, "github");

      const passwordMeRes = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${passwordTokens.accessToken}` },
      });
      assert.equal(passwordMeRes.statusCode, 200);
      assert.equal(passwordMeRes.json<{ user: { provider: string } }>().user.provider, "email");

      const oauthLogoutRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { authorization: `Bearer ${oauthUser.accessToken}` },
      });
      assert.equal(oauthLogoutRes.statusCode, 200);

      const passwordMeAfterOAuthLogout = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${passwordTokens.accessToken}` },
      });
      assert.equal(passwordMeAfterOAuthLogout.statusCode, 200);
    });
  });
});

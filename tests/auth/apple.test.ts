import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { FakeOAuthClient } from "../helpers/fake-oauth-client.js";
import { PendingAuthStore } from "../../src/services/pending-auth-store.js";

const VALID_CODE_CHALLENGE = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const VALID_REDIRECT_URI = "https://app.example.com/oauth/callback";
const FAKE_IDENTITY = {
  providerUserId: "apple-user-123",
  providerUsername: "fake-apple-user",
  email: "fake-apple-user@example.com",
};

describe("Apple OAuth routes", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp({
      appleClient: new FakeOAuthClient(FAKE_IDENTITY),
    });
  });

  after(async () => {
    await ctx.cleanup();
  });

  // ── GET /auth/apple ────────────────────────────────────────────────────────

  describe("GET /auth/apple", () => {
    it("returns authUrl pointing to appleid.apple.com and a non-empty state token", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ authUrl: string; state: string }>();
      assert.ok(
        body.authUrl.includes("appleid.apple.com"),
        `authUrl should point to appleid.apple.com, got: ${body.authUrl}`,
      );
      assert.ok(body.state, "state should be present");
      assert.ok(body.state.length > 0, "state should be non-empty");
    });

    it("authUrl contains the provided redirect_uri and code_challenge", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ authUrl: string; state: string }>();
      const url = new URL(body.authUrl);
      assert.equal(url.searchParams.get("redirect_uri"), VALID_REDIRECT_URI);
      assert.equal(url.searchParams.get("code_challenge"), VALID_CODE_CHALLENGE);
      assert.equal(url.searchParams.get("state"), body.state);
    });

    it("returns 400 when redirect_uri query param is missing", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?code_challenge=${VALID_CODE_CHALLENGE}`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when code_challenge query param is missing", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when code_challenge is too short (< 43 chars)", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=tooshort`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when code_challenge_method is an unsupported value", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=MD5`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("allows localhost redirect URI even if not in allow-list", async () => {
      const localhostUri = "http://localhost:3000/callback";
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(localhostUri)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ authUrl: string; state: string }>();
      const url = new URL(body.authUrl);
      assert.equal(url.searchParams.get("redirect_uri"), localhostUri);
    });

    it("allows 127.0.0.1 redirect URI even if not in allow-list", async () => {
      const loopbackUri = "http://127.0.0.1:8080/callback";
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(loopbackUri)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
      });

      assert.equal(res.statusCode, 200);
    });

    it("rejects a remote redirect URI not in allow-list", async () => {
      const remoteUri = "https://evil.com/callback";
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(remoteUri)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("rejects custom-scheme redirect URIs for Apple web flow", async () => {
      const customUri = "myapp://oauth/callback";
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(customUri)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
      });

      assert.equal(res.statusCode, 400);
    });
  });

  // ── POST /auth/apple/init ──────────────────────────────────────────────────

  describe("POST /auth/apple/init", () => {
    it("records clientType and the optional device descriptor on the pending session", async () => {
      const sessionToken = crypto.randomBytes(32).toString("hex");
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/init",
        headers: {
          "content-type": "application/json",
          "x-sesori-session-token": sessionToken,
        },
        payload: JSON.stringify({
          clientType: "app_ios",
          device: { name: "Alex's iPhone", osVersion: "17.2", appVersion: "1.2.0" },
        }),
      });

      assert.equal(res.statusCode, 200);
      const pendingSession = ctx.pendingAuthStore.getSession(PendingAuthStore.hashToken(sessionToken));
      assert.equal(pendingSession?.provider, "apple");
      assert.equal(pendingSession?.clientType, "app_ios");
      assert.deepEqual(pendingSession?.device, {
        name: "Alex's iPhone",
        osVersion: "17.2",
        appVersion: "1.2.0",
      });
    });
  });

  // ── POST /auth/apple/callback ──────────────────────────────────────────────

  describe("POST /auth/apple/callback", () => {
    it("completes full OAuth callback flow for first-time login", async () => {
      const initRes = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });
      assert.equal(initRes.statusCode, 200);
      const { state } = initRes.json<{ authUrl: string; state: string }>();

      const callbackRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          code: "fake-auth-code",
          codeVerifier: "fake-code-verifier",
          state,
          redirectUri: VALID_REDIRECT_URI,
        }),
      });

      assert.equal(callbackRes.statusCode, 200);
      const body = callbackRes.json<{
        accessToken: string;
        refreshToken: string;
        user: { id: string; provider: string; providerUserId: string; providerUsername: string | null };
      }>();
      assert.ok(body.accessToken, "Should return access token");
      assert.ok(body.refreshToken, "Should return refresh token");
      assert.ok(body.user.id, "Should return user id");
      assert.equal(body.user.provider, "apple");
      assert.equal(body.user.providerUserId, FAKE_IDENTITY.providerUserId);
      assert.equal(body.user.providerUsername, FAKE_IDENTITY.providerUsername);
    });

    it("returns same user on repeat login with same provider account", async () => {
      const initRes1 = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });
      assert.equal(initRes1.statusCode, 200);
      const { state: state1 } = initRes1.json<{ authUrl: string; state: string }>();

      const callbackRes1 = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          code: "fake-auth-code-1",
          codeVerifier: "fake-code-verifier-1",
          state: state1,
          redirectUri: VALID_REDIRECT_URI,
        }),
      });
      assert.equal(callbackRes1.statusCode, 200);
      const firstUserId = callbackRes1.json<{ user: { id: string } }>().user.id;

      const initRes2 = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });
      assert.equal(initRes2.statusCode, 200);
      const { state: state2 } = initRes2.json<{ authUrl: string; state: string }>();

      const callbackRes2 = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          code: "fake-auth-code-2",
          codeVerifier: "fake-code-verifier-2",
          state: state2,
          redirectUri: VALID_REDIRECT_URI,
        }),
      });
      assert.equal(callbackRes2.statusCode, 200);
      const secondUserId = callbackRes2.json<{ user: { id: string } }>().user.id;

      assert.equal(secondUserId, firstUserId);
    });

    it("rejects reused state token (consumed on first use)", async () => {
      const initRes = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });
      assert.equal(initRes.statusCode, 200);
      const { state } = initRes.json<{ authUrl: string; state: string }>();

      const firstCallback = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          code: "fake-auth-code-first",
          codeVerifier: "fake-code-verifier-first",
          state,
          redirectUri: VALID_REDIRECT_URI,
        }),
      });
      assert.equal(firstCallback.statusCode, 200);

      const secondCallback = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          code: "fake-auth-code-second",
          codeVerifier: "fake-code-verifier-second",
          state,
          redirectUri: VALID_REDIRECT_URI,
        }),
      });

      assert.equal(secondCallback.statusCode, 400);
      assert.equal(secondCallback.json<{ error: string }>().error, "bad_request");
    });

    it("returns 400 when state was never issued by this server", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          code: "some-auth-code",
          codeVerifier: "some-pkce-verifier",
          state: "totally-fake-state-that-was-never-created",
          redirectUri: VALID_REDIRECT_URI,
        }),
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.json<{ error: string }>().error, "bad_request");
    });

    it("returns 400 when redirect_uri does not match", async () => {
      const initRes = await ctx.app.inject({
        method: "GET",
        url: `/auth/apple?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });
      assert.equal(initRes.statusCode, 200);
      const { state } = initRes.json<{ authUrl: string; state: string }>();

      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          code: "some-auth-code",
          codeVerifier: "some-pkce-verifier",
          state,
          redirectUri: "https://evil.com/callback",
        }),
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when required body fields are missing", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ code: "some-auth-code" }),
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when body is completely empty", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({}),
      });

      assert.equal(res.statusCode, 400);
    });
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { FakeOAuthClient } from "../helpers/fake-oauth-client.js";
import { PendingAuthStore } from "../../src/services/pending-auth-store.js";
import { MongoDbDatabase, AuthDbCollection } from "../../src/types/mongo.js";
import type { OAuthAccount } from "../../src/models/documents.js";

// A valid 43-character PKCE code_challenge (URL-safe base64, no padding)
const VALID_CODE_CHALLENGE = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const VALID_REDIRECT_URI = "myapp://oauth/callback";
const VALID_SESSION_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const FAKE_IDENTITY = {
  providerUserId: "github-user-123",
  providerUsername: "fake-github-user",
  email: "fake-github-user@example.com",
};

describe("GitHub OAuth routes", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp({
      githubClient: new FakeOAuthClient(FAKE_IDENTITY),
    });
  });

  after(async () => {
    await ctx.cleanup();
  });

  // ── GET /auth/github ────────────────────────────────────────────────────────

  describe("GET /auth/github", () => {
    it("returns authUrl pointing to github.com and a non-empty state token", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/github?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ authUrl: string; state: string }>();
      assert.ok(body.authUrl.includes("github.com"), `authUrl should point to github.com, got: ${body.authUrl}`);
      assert.ok(body.state, "state should be present");
      assert.ok(body.state.length > 0, "state should be non-empty");
    });

    it("authUrl contains the provided redirect_uri and code_challenge", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/github?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
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
        url: `/auth/github?code_challenge=${VALID_CODE_CHALLENGE}`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when code_challenge query param is missing", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/github?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when code_challenge is too short (< 43 chars)", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/github?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=tooshort`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when code_challenge_method is an unsupported value", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/github?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=MD5`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("allows localhost redirect URI even if not in allow-list", async () => {
      const localhostUri = "http://localhost:3000/callback";
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/github?redirect_uri=${encodeURIComponent(localhostUri)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
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
        url: `/auth/github?redirect_uri=${encodeURIComponent(loopbackUri)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
      });

      assert.equal(res.statusCode, 200);
    });

    it("rejects a remote redirect URI not in allow-list", async () => {
      const remoteUri = "https://evil.com/callback";
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/github?redirect_uri=${encodeURIComponent(remoteUri)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
      });

      assert.equal(res.statusCode, 400);
    });
  });

  describe("POST /auth/github/init", () => {
    it("creates a pending session and returns a backend-callback auth URL", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/init",
        headers: {
          "content-type": "application/json",
          "x-sesori-session-token": VALID_SESSION_TOKEN,
        },
        payload: JSON.stringify({ clientType: "bridge-macos" }),
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ authUrl: string; state: string; userCode: string; expiresIn: number }>();
      assert.equal(body.expiresIn, 300);
      assert.match(body.state, /^[a-f0-9]{64}$/);
      assert.match(body.userCode, /^[A-Z2-9]{4}$/);

      const authUrl = new URL(body.authUrl);
      assert.equal(authUrl.origin, "https://github.com");
      assert.equal(authUrl.searchParams.get("redirect_uri"), "https://api.sesori.com/auth/github/callback");
      assert.equal(authUrl.searchParams.get("state"), body.state);
      assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
      assert.ok(authUrl.searchParams.get("code_challenge"));
      assert.ok(!body.authUrl.includes(VALID_SESSION_TOKEN));

      const session = ctx.pendingAuthStore.getSession(PendingAuthStore.hashToken(VALID_SESSION_TOKEN));
      assert.ok(session, "pending auth session should be stored");
      assert.equal(session?.state, body.state);
      assert.equal(session?.userCode, body.userCode);
      assert.equal(session?.provider, "github");
      assert.ok(session?.pkceVerifier);
    });

    it("returns 400 when the session token header is missing", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/init",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ clientType: "bridge" }),
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.json<{ error: string }>().error, "bad_request");
    });

    it("returns 400 when clientType is invalid", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/init",
        headers: {
          "content-type": "application/json",
          "x-sesori-session-token": VALID_SESSION_TOKEN,
        },
        payload: JSON.stringify({ clientType: "desktop" }),
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.json<{ error: string }>().error, "bad_request");
    });
  });

  describe("OAuth confirmation flow end-to-end (real DB) (QA-2)", () => {
    function freshSessionToken(): string {
      return crypto.randomBytes(32).toString("hex");
    }

    async function countOAuthAccountsForProviderUserId(providerUserId: string): Promise<number> {
      const collection = ctx.dbAccessor.getCollection<OAuthAccount>(
        MongoDbDatabase.Auth,
        AuthDbCollection.OAuthAccounts,
      );
      return await collection.countDocuments({ provider: "github", providerUserId });
    }

    it("creates exactly one user document on confirm and zero on deny", async () => {
      const confirmedToken = freshSessionToken();
      const initRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/init",
        headers: { "content-type": "application/json", "x-sesori-session-token": confirmedToken },
        payload: JSON.stringify({ clientType: "bridge_macos" }),
      });
      const initBody = initRes.json<{ state: string }>();

      const callbackRes = await ctx.app.inject({
        method: "GET",
        url: `/auth/github/callback?code=fake-code&state=${initBody.state}`,
      });
      assert.equal(callbackRes.statusCode, 200);

      const confirmRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/callback/confirm",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ state: initBody.state, action: "confirm" }),
      });
      assert.equal(confirmRes.statusCode, 200);

      const statusRes = await ctx.app.inject({
        method: "GET",
        url: "/auth/session/status",
        headers: { "x-sesori-session-token": confirmedToken },
      });
      assert.equal(statusRes.statusCode, 200);
      const statusBody = statusRes.json<{ status: string; user: { id: string } }>();
      assert.equal(statusBody.status, "complete");
      assert.ok(ObjectId.isValid(statusBody.user.id), "user id should be a valid ObjectId");
      assert.equal(await countOAuthAccountsForProviderUserId(FAKE_IDENTITY.providerUserId), 1);

      const deniedToken = freshSessionToken();
      const initRes2 = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/init",
        headers: { "content-type": "application/json", "x-sesori-session-token": deniedToken },
        payload: JSON.stringify({ clientType: "bridge_macos" }),
      });
      const initBody2 = initRes2.json<{ state: string }>();

      await ctx.app.inject({
        method: "GET",
        url: `/auth/github/callback?code=fake-code-2&state=${initBody2.state}`,
      });
      const denyRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/callback/confirm",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ state: initBody2.state, action: "deny" }),
      });

      assert.equal(denyRes.statusCode, 200);
      assert.match(denyRes.body, /Sign-in cancelled/);

      const deniedStatusRes = await ctx.app.inject({
        method: "GET",
        url: "/auth/session/status",
        headers: { "x-sesori-session-token": deniedToken },
      });
      assert.equal(deniedStatusRes.statusCode, 200);
      assert.equal(deniedStatusRes.json<{ status: string }>().status, "denied");

      assert.equal(await countOAuthAccountsForProviderUserId(FAKE_IDENTITY.providerUserId), 1);
    });
  });

  // ── POST /auth/github/callback ──────────────────────────────────────────────

  describe("POST /auth/github/callback", () => {
    it("completes full OAuth callback flow for first-time login", async () => {
      const initRes = await ctx.app.inject({
        method: "GET",
        url: `/auth/github?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });
      assert.equal(initRes.statusCode, 200);
      const { state } = initRes.json<{ authUrl: string; state: string }>();

      const callbackRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/callback",
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
      assert.equal(body.user.provider, "github");
      assert.equal(body.user.providerUserId, FAKE_IDENTITY.providerUserId);
      assert.equal(body.user.providerUsername, FAKE_IDENTITY.providerUsername);
    });

    it("returns same user on repeat login with same provider account", async () => {
      const initRes1 = await ctx.app.inject({
        method: "GET",
        url: `/auth/github?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });
      assert.equal(initRes1.statusCode, 200);
      const { state: state1 } = initRes1.json<{ authUrl: string; state: string }>();

      const callbackRes1 = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/callback",
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
        url: `/auth/github?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });
      assert.equal(initRes2.statusCode, 200);
      const { state: state2 } = initRes2.json<{ authUrl: string; state: string }>();

      const callbackRes2 = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/callback",
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
        url: `/auth/github?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });
      assert.equal(initRes.statusCode, 200);
      const { state } = initRes.json<{ authUrl: string; state: string }>();

      const firstCallback = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/callback",
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
        url: "/auth/github/callback",
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
        url: "/auth/github/callback",
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

    it("returns 400 when required body fields are missing", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/callback",
        headers: { "content-type": "application/json" },
        // Only 'code' provided — missing codeVerifier, state, redirectUri
        payload: JSON.stringify({ code: "some-auth-code" }),
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when body is completely empty", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({}),
      });

      assert.equal(res.statusCode, 400);
    });

    it("uses a real state token but still rejects (state is consumed on first use)", async () => {
      // First, obtain a real state token from GET /auth/github
      const initRes = await ctx.app.inject({
        method: "GET",
        url: `/auth/github?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });
      assert.equal(initRes.statusCode, 200);
      const { state } = initRes.json<{ authUrl: string; state: string }>();

      // Now use the real state in the callback — it will pass state validation
      // but fail at the GitHub API call (502) since we're not mocking GitHub
      const callbackRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/github/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          code: "fake-code",
          codeVerifier: "fake-verifier",
          state,
          redirectUri: VALID_REDIRECT_URI,
        }),
      });

      // State is valid, so we get past state validation.
      // The GitHub token exchange will fail (502) since we're not mocking GitHub.
      assert.ok(
        callbackRes.statusCode !== 400 || callbackRes.json<{ error: string }>().error !== "bad_request",
        "Should not fail on state validation when using a real state token",
      );
    });
  });
});

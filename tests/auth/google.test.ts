import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { PendingAuthStore } from "../../src/services/pending-auth-store.js";

// A valid 43-character PKCE code_challenge (URL-safe base64, no padding)
const VALID_CODE_CHALLENGE = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const VALID_REDIRECT_URI = "myapp://oauth/callback";
const VALID_SESSION_TOKEN = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("Google OAuth routes", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  // ── GET /auth/google ────────────────────────────────────────────────────────

  describe("GET /auth/google", () => {
    it("returns authUrl pointing to accounts.google.com and a non-empty state token", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/google?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ authUrl: string; state: string }>();
      assert.ok(
        body.authUrl.includes("accounts.google.com"),
        `authUrl should point to accounts.google.com, got: ${body.authUrl}`,
      );
      assert.ok(body.state, "state should be present");
      assert.ok(body.state.length > 0, "state should be non-empty");
    });

    it("authUrl contains the provided redirect_uri, code_challenge, and state", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/google?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ authUrl: string; state: string }>();
      const url = new URL(body.authUrl);
      assert.equal(url.searchParams.get("redirect_uri"), VALID_REDIRECT_URI);
      assert.equal(url.searchParams.get("code_challenge"), VALID_CODE_CHALLENGE);
      assert.equal(url.searchParams.get("state"), body.state);
      assert.equal(url.searchParams.get("response_type"), "code");
    });

    it("returns 400 when redirect_uri query param is missing", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/google?code_challenge=${VALID_CODE_CHALLENGE}`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when code_challenge query param is missing", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/google?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when code_challenge is too short (< 43 chars)", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/google?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=tooshort`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when code_challenge_method is an unsupported value", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/google?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=RS256`,
      });

      assert.equal(res.statusCode, 400);
    });

    it("allows localhost redirect URI even if not in allow-list", async () => {
      const localhostUri = "http://localhost:3000/callback";
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/google?redirect_uri=${encodeURIComponent(localhostUri)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
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
        url: `/auth/google?redirect_uri=${encodeURIComponent(loopbackUri)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
      });

      assert.equal(res.statusCode, 200);
    });

    it("rejects a remote redirect URI not in allow-list", async () => {
      const remoteUri = "https://evil.com/callback";
      const res = await ctx.app.inject({
        method: "GET",
        url: `/auth/google?redirect_uri=${encodeURIComponent(remoteUri)}&code_challenge=${VALID_CODE_CHALLENGE}&code_challenge_method=S256`,
      });

      assert.equal(res.statusCode, 400);
    });
  });

  describe("POST /auth/google/init", () => {
    it("creates a pending session and returns a backend-callback auth URL", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/google/init",
        headers: {
          "content-type": "application/json",
          "x-sesori-session-token": VALID_SESSION_TOKEN,
        },
        payload: JSON.stringify({ clientType: "app_android" }),
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ authUrl: string; state: string; userCode: string; expiresIn: number }>();
      assert.equal(body.expiresIn, 300);
      assert.match(body.state, /^[a-f0-9]{64}$/);
      assert.match(body.userCode, /^[A-Z2-9]{4}$/);

      const authUrl = new URL(body.authUrl);
      assert.equal(authUrl.origin, "https://accounts.google.com");
      assert.equal(authUrl.searchParams.get("redirect_uri"), "https://api.sesori.com/auth/google/callback");
      assert.equal(authUrl.searchParams.get("state"), body.state);
      assert.equal(authUrl.searchParams.get("response_type"), "code");
      assert.equal(authUrl.searchParams.get("prompt"), "consent");
      assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
      assert.ok(authUrl.searchParams.get("code_challenge"));
      assert.ok(!body.authUrl.includes(VALID_SESSION_TOKEN));

      const session = ctx.pendingAuthStore.getSession(PendingAuthStore.hashToken(VALID_SESSION_TOKEN));
      assert.ok(session, "pending auth session should be stored");
      assert.equal(session?.state, body.state);
      assert.equal(session?.userCode, body.userCode);
      assert.equal(session?.provider, "google");
      assert.ok(session?.pkceVerifier);
    });

    it("returns 400 for an unknown clientType", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/google/init",
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

  // ── POST /auth/google/callback ──────────────────────────────────────────────

  describe("POST /auth/google/callback", () => {
    it("returns 400 when state was never issued by this server", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/google/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          code: "some-auth-code",
          codeVerifier: "some-pkce-verifier",
          state: "fake-state-never-created-by-server",
          redirectUri: VALID_REDIRECT_URI,
        }),
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.json<{ error: string }>().error, "bad_request");
    });

    it("returns 400 when required body fields are missing", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/google/callback",
        headers: { "content-type": "application/json" },
        // Only 'code' provided — missing codeVerifier, state, redirectUri
        payload: JSON.stringify({ code: "some-auth-code" }),
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when body is completely empty", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/google/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({}),
      });

      assert.equal(res.statusCode, 400);
    });

    it("uses a real state token but still fails at Google API (502), not at state validation", async () => {
      // Obtain a real state token from GET /auth/google
      const initRes = await ctx.app.inject({
        method: "GET",
        url: `/auth/google?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
      });
      assert.equal(initRes.statusCode, 200);
      const { state } = initRes.json<{ authUrl: string; state: string }>();

      // Use the real state in the callback — state validation passes,
      // but the Google token exchange will fail (502) since we're not mocking Google
      const callbackRes = await ctx.app.inject({
        method: "POST",
        url: "/auth/google/callback",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          code: "fake-code",
          codeVerifier: "fake-verifier",
          state,
          redirectUri: VALID_REDIRECT_URI,
        }),
      });

      // Should NOT fail with "Invalid or expired state" — state was valid
      assert.ok(
        callbackRes.statusCode !== 400 || callbackRes.json<{ error: string }>().error !== "bad_request",
        "Should not fail on state validation when using a real state token",
      );
    });
  });
});

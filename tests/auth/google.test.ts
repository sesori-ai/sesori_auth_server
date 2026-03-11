import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";

// A valid 43-character PKCE code_challenge (URL-safe base64, no padding)
const VALID_CODE_CHALLENGE = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const VALID_REDIRECT_URI = "myapp://oauth/callback";

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
        `authUrl should point to accounts.google.com, got: ${body.authUrl}`
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
      assert.equal(
        res.json<{ error: string }>().error,
        "Invalid or expired state"
      );
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
        callbackRes.statusCode !== 400 ||
          callbackRes.json<{ error: string }>().error !== "Invalid or expired state",
        "Should not fail on state validation when using a real state token"
      );
    });
  });
});

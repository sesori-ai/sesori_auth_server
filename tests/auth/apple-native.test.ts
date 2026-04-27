import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import type { AppleNativeVerifier } from "../../src/services/apple-native-verifier.js";
import { BadGatewayError } from "../../src/lib/errors.js";

const FAKE_IDENTITY = {
  providerUserId: "apple-user-123",
  providerUsername: "fake-apple-user@example.com",
  email: "fake-apple-user@example.com",
};

class FakeAppleNativeVerifier {
  private identity: { providerUserId: string; providerUsername: string | null; email: string | null };

  constructor(identity: { providerUserId: string; providerUsername: string | null; email: string | null }) {
    this.identity = identity;
  }

  async verifyIdToken(
    _idToken: string,
    _clientId: string,
    _nonce?: string,
  ): Promise<{ providerUserId: string; providerUsername: string | null; email: string | null }> {
    return this.identity;
  }
}

class FakeFailingAppleNativeVerifier {
  async verifyIdToken(
    _idToken: string,
    _clientId: string,
    _nonce?: string,
  ): Promise<{ providerUserId: string; providerUsername: string | null; email: string | null }> {
    throw new BadGatewayError({ debugMessage: "Invalid Apple ID token" });
  }
}

describe("Apple Native OAuth routes", () => {
  let ctx: TestContext;

  before(async () => {
    const fakeVerifier = new FakeAppleNativeVerifier(FAKE_IDENTITY) as unknown as AppleNativeVerifier;
    ctx = await createTestApp({
      appleNativeVerifier: fakeVerifier,
    });
  });

  after(async () => {
    await ctx.cleanup();
  });

  describe("POST /auth/apple/native", () => {
    it("returns tokens for valid idToken", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/native",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          idToken: "valid-apple-id-token",
          nonce: "test-nonce-123",
        }),
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{
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

    it("returns same user on repeat login with same Apple account", async () => {
      const res1 = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/native",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          idToken: "first-apple-id-token",
          nonce: "test-nonce-123",
        }),
      });
      assert.equal(res1.statusCode, 200);
      const firstUserId = res1.json<{ user: { id: string } }>().user.id;

      const res2 = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/native",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          idToken: "second-apple-id-token",
          nonce: "test-nonce-123",
        }),
      });
      assert.equal(res2.statusCode, 200);
      const secondUserId = res2.json<{ user: { id: string } }>().user.id;

      assert.equal(secondUserId, firstUserId, "Same Apple user should get same Sesori user");
    });

    it("returns 400 when idToken is missing", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/native",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({}),
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when idToken is empty string", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/native",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          idToken: "",
          nonce: "test-nonce-123",
        }),
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when nonce is missing", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/native",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          idToken: "valid-apple-id-token",
        }),
      });

      assert.equal(res.statusCode, 400);
    });
  });
});

describe("Apple Native OAuth routes with failing verifier", () => {
  let ctx: TestContext;

  before(async () => {
    const failingVerifier = new FakeFailingAppleNativeVerifier() as unknown as AppleNativeVerifier;
    ctx = await createTestApp({
      appleNativeVerifier: failingVerifier,
    });
  });

  after(async () => {
    await ctx.cleanup();
  });

  describe("POST /auth/apple/native", () => {
    it("returns 502 when verifier throws BadGatewayError", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/apple/native",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          idToken: "invalid-apple-id-token",
          nonce: "test-nonce-123",
        }),
      });

      assert.equal(res.statusCode, 502);
    });
  });
});

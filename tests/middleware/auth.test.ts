import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import { UnauthenticatedError } from "../../src/lib/errors.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";
import { TokenService } from "../../src/services/token-service.js";

function buildTokenService(): TokenService {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  return new TokenService(privateKey, publicKey);
}

function buildRequest(authorization?: string): FastifyRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
    user: null,
  } as unknown as FastifyRequest;
}

const reply = {} as FastifyReply;
const userId = "69b2aeaa1755fd6c00000001";

describe("createAuthMiddleware", () => {
  it("rejects an unauthenticated request when no options are supplied", async () => {
    const requireAuth = createAuthMiddleware(buildTokenService());
    const request = buildRequest();

    await assert.rejects(() => requireAuth(request, reply), UnauthenticatedError);
    assert.equal(request.user, null);
  });

  it("rejects an unauthenticated request when the dev bypass is explicitly disabled", async () => {
    const requireAuth = createAuthMiddleware(buildTokenService(), { devBypassEnabled: false });
    const request = buildRequest();

    await assert.rejects(() => requireAuth(request, reply), UnauthenticatedError);
    assert.equal(request.user, null);
  });

  // Regression guard: the bypass used to activate implicitly from NODE_ENV, so a
  // production process started with NODE_ENV=development accepted every request
  // as a hardcoded user. The decision must now come only from the injected flag.
  it("ignores NODE_ENV when deciding whether to bypass authentication", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      const requireAuth = createAuthMiddleware(buildTokenService());
      const request = buildRequest();

      await assert.rejects(() => requireAuth(request, reply), UnauthenticatedError);
      assert.equal(request.user, null);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("rejects a malformed bearer token", async () => {
    const requireAuth = createAuthMiddleware(buildTokenService(), { devBypassEnabled: false });
    const request = buildRequest("Bearer not-a-jwt");

    await assert.rejects(() => requireAuth(request, reply), UnauthenticatedError);
    assert.equal(request.user, null);
  });

  it("rejects a token signed by a different key", async () => {
    const foreign = buildTokenService();
    const token = foreign.signAccessToken({ userId, provider: "github", providerUserId: "123" });
    const requireAuth = createAuthMiddleware(buildTokenService(), { devBypassEnabled: false });
    const request = buildRequest(`Bearer ${token}`);

    await assert.rejects(() => requireAuth(request, reply), UnauthenticatedError);
    assert.equal(request.user, null);
  });

  it("authenticates a valid bearer token", async () => {
    const tokenService = buildTokenService();
    const token = tokenService.signAccessToken({ userId, provider: "github", providerUserId: "123" });
    const requireAuth = createAuthMiddleware(tokenService, { devBypassEnabled: false });
    const request = buildRequest(`Bearer ${token}`);

    await requireAuth(request, reply);

    assert.equal(request.user?.userId, userId);
    assert.equal(request.user?.tokenType, "access");
  });

  it("injects the development user only when the bypass is explicitly enabled", async () => {
    const requireAuth = createAuthMiddleware(buildTokenService(), { devBypassEnabled: true });
    const request = buildRequest();

    await requireAuth(request, reply);

    assert.equal(request.user?.tokenType, "access");
    assert.ok(request.user?.userId);
  });
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import type { FastifyRequest } from "fastify";
import type { ClientIpRequest } from "../../src/lib/client-ip.js";
import { buildSettingsWriteRateLimitKey } from "../../src/routes/settings/settings.js";
import { TokenService } from "../../src/services/token-service.js";

const USER_ID = "69b2aeaa1755fd6c00000001";
const SOCKET_IP = "203.0.113.9";
const RESOLVED_IP = "198.51.100.42";

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
    ip: SOCKET_IP,
  } as unknown as FastifyRequest;
}

function createResolverSpy() {
  const calls: ClientIpRequest[] = [];
  const resolve = (request: ClientIpRequest) => {
    calls.push(request);
    return RESOLVED_IP;
  };

  return { resolve, calls };
}

describe("buildSettingsWriteRateLimitKey", () => {
  // Behind a proxy request.ip is the shared edge address, so falling back to it
  // would put every unauthenticated caller in one bucket.
  it("falls back to the resolved client ip rather than the socket address", async () => {
    const resolver = createResolverSpy();
    const key = buildSettingsWriteRateLimitKey(buildTokenService(), resolver.resolve);

    assert.equal(key(buildRequest()), RESOLVED_IP);
    assert.notEqual(key(buildRequest()), SOCKET_IP);
    assert.equal(resolver.calls.length, 2);
  });

  it("uses the resolved client ip for a token that fails verification", async () => {
    const resolver = createResolverSpy();
    const key = buildSettingsWriteRateLimitKey(buildTokenService(), resolver.resolve);

    assert.equal(key(buildRequest("Bearer not-a-jwt")), RESOLVED_IP);
  });

  it("uses the resolved client ip for a token signed by another key", async () => {
    const foreign = buildTokenService();
    const token = foreign.signAccessToken({ userId: USER_ID, provider: "github", providerUserId: "1" });
    const resolver = createResolverSpy();
    const key = buildSettingsWriteRateLimitKey(buildTokenService(), resolver.resolve);

    assert.equal(key(buildRequest(`Bearer ${token}`)), RESOLVED_IP);
  });

  it("keys a verified token by account without consulting the resolver", async () => {
    const tokenService = buildTokenService();
    const token = tokenService.signAccessToken({ userId: USER_ID, provider: "github", providerUserId: "1" });
    const resolver = createResolverSpy();
    const key = buildSettingsWriteRateLimitKey(tokenService, resolver.resolve);

    assert.equal(key(buildRequest(`Bearer ${token}`)), `user:${USER_ID}`);
    assert.equal(resolver.calls.length, 0, "a verified account key must not depend on the client address");
  });
});

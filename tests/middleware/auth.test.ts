import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyRequest } from "fastify";
import { UnauthenticatedError } from "../../src/lib/errors.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";
import type { AuthService } from "../../src/services/auth-service.js";
import type { TokenService } from "../../src/services/token-service.js";

describe("createAuthMiddleware", () => {
  it("does not convert token-version store failures into 401", async () => {
    const tokenService = {
      verifyAccessToken: () => ({
        tokenType: "access",
        userId: "user-1",
        provider: "github",
        providerUserId: "provider-user-1",
        tokenVersion: 0,
        iss: "auth-backend",
        aud: "mobile",
        exp: 9_999_999_999,
        iat: 1,
      }),
    } as unknown as TokenService;
    const authService = {
      isAccessTokenVersionCurrent: async () => {
        throw new Error("database unavailable");
      },
    } as unknown as AuthService;
    const requireAuth = createAuthMiddleware(tokenService, authService);

    const request = {
      headers: { authorization: "Bearer valid-token" },
      user: null,
    } as unknown as FastifyRequest;

    await assert.rejects(requireAuth(request, {} as never), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof UnauthenticatedError));
      assert.equal(error.message, "database unavailable");
      return true;
    });
  });
});

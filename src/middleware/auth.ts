import { FastifyRequest, FastifyReply } from "fastify";
import { UnauthenticatedError } from "../lib/errors.js";
import { TokenService } from "../services/token-service.js";
import { accessTokenPayloadSchema, type AccessTokenPayload } from "../models/jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AccessTokenPayload | null;
  }
}

export function createAuthMiddleware(tokenService: TokenService) {
  return async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthenticatedError();
    }

    const token = authHeader.slice(7);

    try {
      const raw = tokenService.verifyAccessToken(token);
      const result = accessTokenPayloadSchema.safeParse(raw);
      if (!result.success) {
        throw new UnauthenticatedError({
          debugMessage: "Auth token payload validation failed",
          nestedError: result.error.issues,
        });
      }
      request.user = result.data;
    } catch (error) {
      if (error instanceof UnauthenticatedError) throw error;
      throw new UnauthenticatedError({
        debugMessage: "Auth token verification failed",
        nestedError: error,
      });
    }
  };
}

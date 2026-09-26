import type { FastifyRequest } from "fastify";
import type { ClientIpRequest } from "../lib/client-ip.js";
import { accessTokenPayloadSchema } from "../models/jwt.js";
import type { TokenService } from "../services/token-service.js";

// Per-route limiters run on onRequest, before requireAuth populates
// request.user, so the key is derived here instead. It must be an account
// rather than the token string, because a refresh re-signs the token and would
// otherwise hand out a fresh allowance on demand. The signature is verified
// before the claim is trusted: keying on an unverified claim would let anyone
// forge a Bearer carrying a known userId and exhaust that account's allowance
// without ever authenticating. Anything unverifiable falls back to the caller's
// address, so forged traffic can only consume its own bucket. That address comes
// from the same resolver the global limiter uses rather than request.ip, or
// behind a proxy every unauthenticated caller would collapse into one shared
// bucket.
export function buildAccountRateLimitKey(
  tokenService: TokenService,
  resolveClientIp: (request: ClientIpRequest) => string,
) {
  return (request: FastifyRequest): string => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      return resolveClientIp(request);
    }

    try {
      const claims = accessTokenPayloadSchema.safeParse(tokenService.verifyAccessToken(authorization.slice(7)));
      return claims.success ? `user:${claims.data.userId}` : resolveClientIp(request);
    } catch {
      return resolveClientIp(request);
    }
  };
}

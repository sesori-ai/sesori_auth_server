import { timingSafeEqual } from "node:crypto";
import { FastifyRequest, FastifyReply } from "fastify";
import { UnauthenticatedError } from "../lib/errors.js";

// Constant-time comparison so the shared secret cannot be recovered through
// a timing side-channel on the /internal/* endpoints.
function secretsMatch(provided: string, secret: string): boolean {
  const providedBuf = Buffer.from(provided);
  const secretBuf = Buffer.from(secret);
  return providedBuf.length === secretBuf.length && timingSafeEqual(providedBuf, secretBuf);
}

export function createRelayAuthMiddleware(secret: string | undefined) {
  return async function requireRelayAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!secret) {
      throw new UnauthenticatedError({ debugMessage: "Relay webhook not configured" });
    }
    const provided = request.headers["x-relay-secret"];
    if (typeof provided !== "string" || !secretsMatch(provided, secret)) {
      throw new UnauthenticatedError({ debugMessage: "Invalid relay secret" });
    }
  };
}

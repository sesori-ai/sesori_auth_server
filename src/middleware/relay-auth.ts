import { FastifyRequest, FastifyReply } from "fastify";
import { UnauthenticatedError } from "../lib/errors.js";

export function createRelayAuthMiddleware(secret: string | undefined) {
  return async function requireRelayAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!secret) {
      throw new UnauthenticatedError({ debugMessage: "Relay webhook not configured" });
    }
    const provided = request.headers["x-relay-secret"];
    if (!provided || provided !== secret) {
      throw new UnauthenticatedError({ debugMessage: "Invalid relay secret" });
    }
  };
}

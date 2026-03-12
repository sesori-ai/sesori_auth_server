import { FastifyRequest, FastifyReply } from "fastify";
import { TokenService } from "../services/token-service.js";
import { accessTokenPayloadSchema, type AccessTokenPayload } from "../models/jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AccessTokenPayload | null;
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    await reply.status(401).send({ error: "unauthorized" });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const raw = TokenService.verifyToken(token);
    const result = accessTokenPayloadSchema.safeParse(raw);
    if (!result.success) {
      request.log.warn(
        { reason: "invalid_payload", issues: result.error.issues },
        "Auth token payload validation failed",
      );
      await reply.status(401).send({ error: "unauthorized" });
      return;
    }
    request.user = result.data;
  } catch (e) {
    request.log.warn(e, "Auth token verification failed");
    await reply.status(401).send({ error: "unauthorized" });
  }
}

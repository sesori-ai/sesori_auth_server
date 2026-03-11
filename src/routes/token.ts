import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import {
  AuthServiceError,
  findUserAuthProfile,
  refreshAuthTokens,
} from "../services/auth-service.js";
import { getPublicKey } from "../services/token-service.js";

const refreshBodySchema = z.object({
  refreshToken: z.string(),
});

export const tokenRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/auth/refresh", async (request, reply) => {
    const bodyResult = refreshBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: bodyResult.error.errors,
      });
    }

    try {
      return await refreshAuthTokens(bodyResult.data.refreshToken);
    } catch (error) {
      if (error instanceof AuthServiceError && error.code === "UNAUTHORIZED") {
        request.log.warn(error, "Refresh token verification failed");
        return reply.status(401).send({ error: "unauthorized" });
      }

      throw error;
    }
  });

  fastify.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const profile = await findUserAuthProfile(request.user!.userId);
    if (!profile) {
      return reply.status(404).send({ error: "User not found" });
    }

    return { user: profile };
  });

  fastify.post(
    "/auth/logout",
    { preHandler: requireAuth },
    async (request, reply) => {
      return { success: true };
    }
  );

  fastify.get("/auth/public-key", async (request, reply) => {
    const key = getPublicKey();
    return reply.type("text/plain").send(key);
  });
};

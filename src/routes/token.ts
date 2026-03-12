import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { AuthService, AuthServiceError } from "../services/auth-service.js";
import { TokenService } from "../services/token-service.js";

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
      return await AuthService.refreshAuthTokens(bodyResult.data.refreshToken);
    } catch (error) {
      if (error instanceof AuthServiceError && error.code === "UNAUTHORIZED") {
        request.log.warn(error, "Refresh token verification failed");
        return reply.status(401).send({ error: "unauthorized" });
      }

      throw error;
    }
  });

  fastify.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const profile = await AuthService.findUserAuthProfile(request.user!.userId);
    if (!profile) {
      return reply.status(404).send({ error: "User not found" });
    }

    return { user: profile };
  });

  fastify.post(
    "/auth/logout",
    { preHandler: requireAuth },
    async (request) => {
      await AuthService.logoutUser(request.user!.userId);
      return { success: true };
    }
  );

  fastify.post(
    "/auth/revoke",
    { preHandler: requireAuth },
    async (request) => {
      await AuthService.revoke(request.user!.userId);
      return { success: true };
    }
  );

  fastify.get("/auth/public-key", async (_request, reply) => {
    const key = TokenService.getPublicKey();
    return reply.type("text/plain").send(key);
  });
};

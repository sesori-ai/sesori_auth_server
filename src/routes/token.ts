import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { AuthService, AuthServiceError } from "../services/auth-service.js";
import { TokenService } from "../services/token-service.js";

const refreshBodySchema = z.object({
  refreshToken: z.string(),
});

type RefreshBody = z.infer<typeof refreshBodySchema>;
type RefreshReply = {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
  };
};

type MeReply = {
  user: {
    id: string;
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
  };
};

type SuccessReply = { success: true };

type ErrorReply = { error: string; details?: unknown };

export const tokenRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: RefreshBody; Reply: RefreshReply | ErrorReply }>("/auth/refresh", async (request, reply) => {
    const bodyResult = refreshBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      reply.status(400).send({
        error: "Invalid request body",
        details: bodyResult.error.errors,
      });
      return;
    }

    try {
      return await AuthService.refreshAuthTokens(bodyResult.data.refreshToken);
    } catch (error) {
      if (error instanceof AuthServiceError && error.code === "UNAUTHORIZED") {
        request.log.warn(error, "Refresh token verification failed");
        reply.status(401).send({ error: "unauthorized" });
        return;
      }

      throw error;
    }
  });

  fastify.get<{ Reply: MeReply | ErrorReply }>("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const profile = await AuthService.findUserAuthProfile(request.user!.userId);
    if (!profile) {
      reply.status(404).send({ error: "User not found" });
      return;
    }

    return { user: profile };
  });

  fastify.post<{ Body: void; Reply: SuccessReply }>("/auth/logout", { preHandler: requireAuth }, async (request) => {
    await AuthService.logoutUser(request.user!.userId);
    return { success: true };
  });

  fastify.post<{ Body: void; Reply: SuccessReply }>("/auth/revoke", { preHandler: requireAuth }, async (request) => {
    await AuthService.revoke(request.user!.userId);
    return { success: true };
  });

  fastify.get<{ Reply: string }>("/auth/public-key", async (_request, reply) => {
    const key = TokenService.getPublicKey();
    reply.type("text/plain").send(key);
  });
};

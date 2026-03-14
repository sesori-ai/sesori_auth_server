import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import { requireAuth } from "../middleware/auth.js";
import type { RefreshBody, AuthTokensReply, MeReply, SuccessReply } from "../models/api.js";
import { AuthService } from "../services/auth-service.js";
import { TokenService } from "../services/token-service.js";

const refreshBodySchema = z.object({
  refreshToken: z.string(),
});

export const tokenRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: RefreshBody; Reply: AuthTokensReply }>("/auth/refresh", async (request) => {
    const bodyResult = refreshBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.errors });
    }

    return await AuthService.refreshAuthTokens(bodyResult.data.refreshToken);
  });

  fastify.get<{ Reply: MeReply }>("/auth/me", { preHandler: requireAuth }, async (request) => {
    const profile = await AuthService.findUserAuthProfile(request.user!.userId);
    if (!profile) {
      throw new NotFoundError({ debugMessage: "User not found" });
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

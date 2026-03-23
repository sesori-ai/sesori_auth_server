import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import type { RefreshBody, AuthTokensReply, MeReply, SuccessReply } from "../models/api.js";
import type { AuthService } from "../services/auth-service.js";
import type { TokenService } from "../services/token-service.js";

const refreshBodySchema = z.object({
  refreshToken: z.string(),
});

export type TokenRouteOptions = {
  authService: AuthService;
  tokenService: TokenService;
  requireAuth: (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
};

export const tokenRoutes: FastifyPluginAsync<TokenRouteOptions> = async (fastify, opts) => {
  const { authService, tokenService, requireAuth } = opts;

  fastify.post<{ Body: RefreshBody; Reply: AuthTokensReply }>("/auth/refresh", async (request) => {
    const bodyResult = refreshBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
    }

    return await authService.refreshAuthTokens(bodyResult.data.refreshToken);
  });

  fastify.get<{ Reply: MeReply }>("/auth/me", { preHandler: requireAuth }, async (request) => {
    const profile = await authService.findUserAuthProfile(request.user!.userId);
    if (!profile) {
      throw new NotFoundError({ debugMessage: "User not found" });
    }

    return { user: profile };
  });

  fastify.post<{ Body: void; Reply: SuccessReply }>("/auth/logout", { preHandler: requireAuth }, async (request) => {
    await authService.logoutUser(request.user!.userId);
    return { success: true };
  });

  fastify.post<{ Body: void; Reply: SuccessReply }>("/auth/revoke", { preHandler: requireAuth }, async (request) => {
    await authService.revoke(request.user!.userId);
    return { success: true };
  });

  fastify.get<{ Reply: string }>("/auth/public-key", async (_request, reply) => {
    const key = tokenService.getPublicKey();
    reply.type("text/plain").send(key);
  });
};

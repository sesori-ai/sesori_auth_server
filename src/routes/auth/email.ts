import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { BadRequestError } from "../../lib/errors.js";
import type { PasswordLoginBody, AuthTokensReply } from "../../models/api.js";
import type { AuthService } from "../../services/auth-service.js";

const passwordLoginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export type PasswordRouteOptions = {
  authService: AuthService;
};

export const passwordRoutes: FastifyPluginAsync<PasswordRouteOptions> = async (fastify, opts) => {
  const { authService } = opts;

  fastify.post<{ Body: PasswordLoginBody; Reply: AuthTokensReply }>(
    "/auth/email",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request) => {
      const bodyResult = passwordLoginBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      return await authService.authenticatePassword(bodyResult.data.email, bodyResult.data.password);
    },
  );
};

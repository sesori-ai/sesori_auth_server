import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { BadRequestError } from "../lib/errors.js";
import type { AppleNativeBody, AuthTokensReply } from "../models/api.js";
import type { AuthService } from "../services/auth-service.js";
import type { AppleNativeVerifier } from "../services/apple-native-verifier.js";
import type { Config } from "../config.js";

const appleNativeBodySchema = z.object({
  idToken: z.string().min(1),
  nonce: z.string().optional(),
});

export type AppleNativeRouteOptions = {
  authService: AuthService;
  appleNativeVerifier: AppleNativeVerifier;
  config: Config;
};

export const appleNativeRoutes: FastifyPluginAsync<AppleNativeRouteOptions> = async (fastify, opts) => {
  const { authService, appleNativeVerifier, config } = opts;

  fastify.post<{ Body: AppleNativeBody; Reply: AuthTokensReply }>("/auth/apple/native", async (request) => {
    const bodyResult = appleNativeBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new BadRequestError({ debugMessage: "Invalid request body" });
    }

    const identity = await appleNativeVerifier.verifyIdToken(
      bodyResult.data.idToken,
      config.APPLE_IOS_CLIENT_ID,
      bodyResult.data.nonce,
    );

    return await authService.authenticateAppleNative(identity);
  });
};

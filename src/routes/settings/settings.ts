import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, UnauthenticatedError } from "../../lib/errors.js";
import { deviceIdSchema, updateSettingsBodySchema, type SettingsConfigurationView } from "../../models/settings.js";
import { accessTokenPayloadSchema } from "../../models/jwt.js";
import type { SettingsService } from "../../services/settings-service.js";
import type { TokenService } from "../../services/token-service.js";

function getUserId(request: FastifyRequest): string {
  if (!request.user) {
    throw new UnauthenticatedError();
  }

  return request.user.userId;
}

function parseDeviceId(rawDeviceId: string): string {
  const result = deviceIdSchema.safeParse(rawDeviceId);
  if (!result.success) {
    throw new BadRequestError({ debugMessage: "Invalid deviceId", nestedError: result.error.issues });
  }

  return result.data;
}

// The limiter runs on onRequest, before requireAuth populates request.user, so
// the key is derived here instead. It must be an account rather than the token
// string, because a refresh re-signs the token and would otherwise hand out a
// fresh allowance on demand. The signature is verified before the claim is
// trusted: keying on an unverified claim would let anyone forge a Bearer
// carrying a known userId and exhaust that account's allowance without ever
// authenticating. Anything unverifiable falls back to the caller's address, so
// forged traffic can only consume its own bucket.
export function buildSettingsWriteRateLimitKey(tokenService: TokenService) {
  return (request: FastifyRequest): string => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      return request.ip;
    }

    try {
      const claims = accessTokenPayloadSchema.safeParse(tokenService.verifyAccessToken(authorization.slice(7)));
      return claims.success ? `user:${claims.data.userId}` : request.ip;
    } catch {
      return request.ip;
    }
  };
}

// Each write for an unseen deviceId inserts a settingsConfiguration document,
// and deviceId is client-generated, so this bounds how fast one client can grow
// that collection. Reads create nothing and are not limited beyond the global
// allowance.
const SETTINGS_WRITE_MAX_PER_MINUTE = 30;

export type SettingsRouteOptions = {
  settingsService: SettingsService;
  tokenService: TokenService;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const settingsRoutes: FastifyPluginAsync<SettingsRouteOptions> = async (fastify, opts) => {
  const { settingsService, tokenService, requireAuth } = opts;

  const settingsWriteRateLimit = {
    max: SETTINGS_WRITE_MAX_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: buildSettingsWriteRateLimitKey(tokenService),
  };

  fastify.get<{ Params: { deviceId: string }; Reply: SettingsConfigurationView }>(
    "/auth/settings/:deviceId",
    { preHandler: requireAuth },
    async (request) => {
      const deviceId = parseDeviceId(request.params.deviceId);
      const userId = getUserId(request);
      return settingsService.getForDevice(userId, deviceId);
    },
  );

  fastify.patch<{ Params: { deviceId: string }; Body: unknown; Reply: SettingsConfigurationView }>(
    "/auth/settings/:deviceId",
    { preHandler: requireAuth, config: { rateLimit: settingsWriteRateLimit } },
    async (request) => {
      const deviceId = parseDeviceId(request.params.deviceId);

      const bodyResult = updateSettingsBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid settings payload", nestedError: bodyResult.error.issues });
      }

      const userId = getUserId(request);
      return settingsService.updateForDevice(userId, deviceId, bodyResult.data);
    },
  );
};

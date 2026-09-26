import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, UnauthenticatedError } from "../../lib/errors.js";
import { deviceIdSchema, updateSettingsBodySchema, type SettingsConfigurationView } from "../../models/settings.js";
import type { ClientIpRequest } from "../../lib/client-ip.js";
import { buildAccountRateLimitKey } from "../../middleware/account-rate-limit-key.js";
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

// Each PATCH for an unseen deviceId inserts a settingsConfiguration document,
// and deviceId is client-generated, so this bounds how fast one client can grow
// that collection. DELETE cannot grow it but is still a mutation, so it carries
// the same limit. The plugin counts per route, so the two do not share a bucket:
// an account gets this allowance on each verb, not across both. Reads create
// nothing and are not limited beyond the global allowance.
const SETTINGS_WRITE_MAX_PER_MINUTE = 30;

export type SettingsRouteOptions = {
  settingsService: SettingsService;
  tokenService: TokenService;
  resolveClientIp: (request: ClientIpRequest) => string;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const settingsRoutes: FastifyPluginAsync<SettingsRouteOptions> = async (fastify, opts) => {
  const { settingsService, tokenService, resolveClientIp, requireAuth } = opts;

  const settingsWriteRateLimit = {
    max: SETTINGS_WRITE_MAX_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: buildAccountRateLimitKey(tokenService, resolveClientIp),
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

  // Account-wide, for the account-deletion flow: every device this account
  // configured goes at once. The account is identified by the verified token
  // claim and never by a caller-supplied id, so this cannot be aimed at someone
  // else's settings. It is idempotent for the same reason the reads are: an
  // account with nothing stored already resolves to the defaults.
  fastify.delete<{ Reply: { ok: true } }>(
    "/auth/settings",
    { preHandler: requireAuth, config: { rateLimit: settingsWriteRateLimit } },
    async (request) => {
      const userId = getUserId(request);
      await settingsService.deleteAllForUser(userId);
      return { ok: true };
    },
  );
};

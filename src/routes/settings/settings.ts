import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, UnauthenticatedError } from "../../lib/errors.js";
import { deviceIdSchema, updateSettingsBodySchema, type SettingsConfigurationView } from "../../models/settings.js";
import type { SettingsService } from "../../services/settings-service.js";

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
// the key has to come from the raw header. Keying on the token string itself
// would hand out a fresh allowance on every POST /auth/refresh, so key on the
// userId claim, which survives refresh. The claim is read without verifying the
// signature, which is safe for keying only: a forged token still fails
// authentication and writes nothing, so it can at most split its own buckets
// while burning 401s against the global allowance.
export function settingsWriteRateLimitKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return request.ip;
  }

  const payloadSegment = authorization.slice(7).split(".")[1];
  if (!payloadSegment) {
    return request.ip;
  }

  try {
    const claims: unknown = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    const userId = (claims as { userId?: unknown }).userId;
    return typeof userId === "string" && userId.length > 0 ? `user:${userId}` : request.ip;
  } catch {
    return request.ip;
  }
}

// Each write for an unseen deviceId inserts a settingsConfiguration document,
// and deviceId is client-generated, so this bounds how fast one client can grow
// that collection. Reads create nothing and are not limited beyond the global
// allowance.
const SETTINGS_WRITE_RATE_LIMIT = {
  max: 30,
  timeWindow: "1 minute",
  keyGenerator: settingsWriteRateLimitKey,
};

export type SettingsRouteOptions = {
  settingsService: SettingsService;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const settingsRoutes: FastifyPluginAsync<SettingsRouteOptions> = async (fastify, opts) => {
  const { settingsService, requireAuth } = opts;

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
    { preHandler: requireAuth, config: { rateLimit: SETTINGS_WRITE_RATE_LIMIT } },
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

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
    { preHandler: requireAuth },
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

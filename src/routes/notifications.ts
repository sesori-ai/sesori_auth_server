import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, UnauthenticatedError } from "../lib/errors.js";
import {
  registerTokenBodySchema,
  sendNotificationBodySchema,
  bridgeStatusBodySchema,
  type RegisterTokenBody,
  type SendNotificationBody,
  type BridgeStatusBody,
} from "../models/api.js";
import type { DeviceTokenRepository } from "../repositories/device-token-repo.js";
import type { NotificationService } from "../services/notification-service.js";

export type NotificationRouteOptions = {
  deviceTokenRepo: DeviceTokenRepository;
  notificationService: NotificationService;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireRelayAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

function getUserId(request: FastifyRequest): string {
  if (!request.user) throw new UnauthenticatedError();
  return request.user.userId;
}

export const notificationRoutes: FastifyPluginAsync<NotificationRouteOptions> = async (fastify, opts) => {
  const { deviceTokenRepo, notificationService, requireAuth, requireRelayAuth } = opts;

  fastify.post<{ Body: RegisterTokenBody; Reply: { ok: true } }>(
    "/notifications/register-token",
    { preHandler: requireAuth },
    async (request) => {
      const bodyResult = registerTokenBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      const userId = getUserId(request);
      await deviceTokenRepo.upsertToken(userId, bodyResult.data.token, bodyResult.data.platform);
      return { ok: true };
    },
  );

  fastify.delete<{ Params: { token: string }; Reply: { ok: true } }>(
    "/notifications/tokens/:token",
    { preHandler: requireAuth },
    async (request) => {
      const userId = getUserId(request);
      const token = decodeURIComponent(request.params.token);
      await deviceTokenRepo.deleteByTokenForUser(userId, token);
      return { ok: true };
    },
  );

  fastify.post<{ Body: SendNotificationBody; Reply: { ok: true; devicesNotified: number } }>(
    "/notifications/send",
    { preHandler: requireAuth },
    async (request) => {
      const bodyResult = sendNotificationBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      const userId = getUserId(request);
      const result = await notificationService.sendToUser(userId, bodyResult.data);
      return { ok: true, devicesNotified: result.devicesNotified };
    },
  );

  fastify.post<{ Body: BridgeStatusBody; Reply: { ok: true } }>(
    "/internal/bridge-status",
    { preHandler: requireRelayAuth },
    async (request) => {
      const bodyResult = bridgeStatusBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      if (bodyResult.data.status === "disconnected") {
        await notificationService.sendToUser(bodyResult.data.userId, {
          category: "connection_status",
          title: "Bridge Offline",
          body: "Your bridge has disconnected. AI sessions are paused.",
          collapseKey: "connection_status",
        });
      }

      if (bodyResult.data.status === "connected") {
        await notificationService.sendToUser(bodyResult.data.userId, {
          category: "connection_status",
          title: "Bridge Online",
          body: "Your bridge has reconnected.",
          collapseKey: "connection_status",
        });
      }

      return { ok: true };
    },
  );
};

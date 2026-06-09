import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, NotFoundError, UnauthenticatedError } from "../lib/errors.js";
import {
  registerTokenBodySchema,
  sendNotificationBodySchema,
  bridgeStatusBodySchema,
  type RegisterTokenBody,
  type SendNotificationBody,
  type BridgeStatusBody,
} from "../models/api.js";
import type { DeviceTokenRepository } from "../repositories/device-token-repo.js";
import type { BridgeService } from "../services/bridge-service.js";
import type { BridgeStateTracker } from "../services/bridge-state-tracker.js";
import type { NotificationService } from "../services/notification-service.js";
import type { Config } from "../config.js";

const BRIDGE_STATUS_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function hasBridgeStateAtOrAfter(bridges: { lastSeenAt: string | null }[], at: Date): boolean {
  return bridges.some((bridge) => {
    if (!bridge.lastSeenAt) {
      return false;
    }
    const lastSeenAt = new Date(bridge.lastSeenAt);
    return !Number.isNaN(lastSeenAt.getTime()) && lastSeenAt >= at;
  });
}

function isTooFarInFuture(at: Date, now: Date = new Date()): boolean {
  return at.getTime() - now.getTime() > BRIDGE_STATUS_FUTURE_TOLERANCE_MS;
}

export type NotificationRouteOptions = {
  config: Config;
  deviceTokenRepo: DeviceTokenRepository;
  notificationService: NotificationService;
  bridgeService: BridgeService;
  bridgeStateTracker: BridgeStateTracker;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireRelayAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

function getUserId(request: FastifyRequest): string {
  if (!request.user) throw new UnauthenticatedError();
  return request.user.userId;
}

export const notificationRoutes: FastifyPluginAsync<NotificationRouteOptions> = async (fastify, opts) => {
  const {
    config,
    deviceTokenRepo,
    notificationService,
    bridgeService,
    bridgeStateTracker,
    requireAuth,
    requireRelayAuth,
  } = opts;

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

      const internalStatus: "active" | "inactive" = bodyResult.data.status === "connected" ? "active" : "inactive";
      const at = new Date(bodyResult.data.timestamp);
      if (Number.isNaN(at.getTime())) {
        throw new BadRequestError({ debugMessage: "Invalid timestamp" });
      }
      if (isTooFarInFuture(at)) {
        throw new BadRequestError({ debugMessage: "Timestamp is too far in the future" });
      }

      if (bodyResult.data.bridgeId) {
        const bridge = await bridgeService.findByIdForUser(bodyResult.data.bridgeId, bodyResult.data.userId);
        if (!bridge) {
          throw new NotFoundError({ debugMessage: "Unknown bridgeId for user" });
        }
        await bridgeService.recordStatusChange(bodyResult.data.bridgeId, bodyResult.data.userId, internalStatus, at);
      } else {
        if (config.AUTH_REQUIRE_BRIDGE_ID_IN_STATUS) {
          throw new BadRequestError({ debugMessage: "bridgeId is required" });
        }
        const bridges = await bridgeService.listForUser(bodyResult.data.userId);
        if (bridges.length > 0 && !hasBridgeStateAtOrAfter(bridges, at)) {
          bridgeStateTracker.handleStatusChange(bodyResult.data.userId, internalStatus);
        }
      }

      return { ok: true };
    },
  );
};

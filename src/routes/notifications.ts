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
import { bridgeStatusFromWire } from "../models/bridge.js";
import type { DeviceTokenRepository } from "../repositories/device-token-repo.js";
import type { BridgeService } from "../services/bridge-service.js";
import type { NotificationService } from "../services/notification-service.js";
import type { ActivationService } from "../services/activation-service.js";
import type { AppClientPresenceService } from "../services/app-client-presence-service.js";
import type { Config } from "../config.js";

// Allow up to 5 minutes of NTP clock skew between the relay and this server
// before rejecting a status timestamp as "from the future".
const BRIDGE_STATUS_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function isTooFarInFuture(at: Date, now: Date = new Date()): boolean {
  return at.getTime() - now.getTime() > BRIDGE_STATUS_FUTURE_TOLERANCE_MS;
}

export type NotificationRouteOptions = {
  config: Config;
  deviceTokenRepo: DeviceTokenRepository;
  appClientPresenceService: AppClientPresenceService;
  notificationService: NotificationService;
  bridgeService: BridgeService;
  activationService: ActivationService;
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
    appClientPresenceService,
    notificationService,
    bridgeService,
    activationService,
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

      if (config.AUTH_REQUIRE_DEVICE_ID_IN_TOKEN_REGISTRATION && !bodyResult.data.deviceId) {
        throw new BadRequestError({ debugMessage: "deviceId is required" });
      }

      const userId = getUserId(request);
      await appClientPresenceService.registerToken({
        userId,
        token: bodyResult.data.token,
        platform: bodyResult.data.platform,
        deviceId: bodyResult.data.deviceId,
      });
      try {
        await activationService.recordAppSetup(userId);
      } catch (error) {
        console.warn("[ActivationService] Failed to record app setup", { userId, error });
      }
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

  // Trust model: the relay secret authenticates the CALLER as our relay, but
  // we do not verify the relay is authorized for any specific bridgeId — a
  // single trusted relay is assumed. A multi-relay topology must revisit this.
  fastify.post<{ Body: BridgeStatusBody; Reply: { ok: true } }>(
    "/internal/bridge-status",
    { preHandler: requireRelayAuth },
    async (request) => {
      const bodyResult = bridgeStatusBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      const internalStatus = bridgeStatusFromWire(bodyResult.data.status);
      const at = new Date(bodyResult.data.timestamp);
      if (Number.isNaN(at.getTime())) {
        throw new BadRequestError({ debugMessage: "Invalid timestamp" });
      }
      if (isTooFarInFuture(at)) {
        throw new BadRequestError({ debugMessage: "Timestamp is too far in the future" });
      }

      const { found } = await bridgeService.recordStatusChange(
        bodyResult.data.bridgeId,
        bodyResult.data.userId,
        internalStatus,
        at,
      );
      if (!found) {
        // Contract with the relay: this 404 becomes WS close 4006, telling
        // the bridge to re-register. Do not weaken to a 200 — see AGENTS.md
        // BRIDGE SUBSYSTEM.
        throw new NotFoundError({ debugMessage: "Unknown bridgeId for user" });
      }

      return { ok: true };
    },
  );
};

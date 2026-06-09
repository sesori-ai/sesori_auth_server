import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, NotFoundError, UnauthenticatedError } from "../lib/errors.js";
import {
  registerBridgeBodySchema,
  bridgeIdPathParamSchema,
  validateBridgeTokenBodySchema,
  type BridgesListReply,
  type RegisterBridgeReply,
  type ValidateBridgeTokenBody,
} from "../models/api.js";
import { bridgeTokenPayloadSchema } from "../models/jwt.js";
import type { BridgeService } from "../services/bridge-service.js";
import type { TokenService } from "../services/token-service.js";

function getUserId(request: FastifyRequest): string {
  if (!request.user) throw new UnauthenticatedError();
  return request.user.userId;
}

export type BridgeRouteOptions = {
  bridgeService: BridgeService;
  tokenService: TokenService;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireRelayAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const bridgeRoutes: FastifyPluginAsync<BridgeRouteOptions> = async (fastify, opts) => {
  const { bridgeService, tokenService, requireAuth, requireRelayAuth } = opts;

  fastify.post<{ Body: unknown; Reply: RegisterBridgeReply }>(
    "/auth/bridges",
    { preHandler: requireAuth },
    async (request, reply) => {
      const bodyResult = registerBridgeBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      const userId = getUserId(request);
      const summary = await bridgeService.registerForUser(userId, bodyResult.data.name, bodyResult.data.platform);
      const bridgeToken = tokenService.signBridgeToken({ userId, bridgeId: summary.id });
      reply.status(201);
      return { ...summary, bridgeToken };
    },
  );

  fastify.post<{ Body: ValidateBridgeTokenBody; Reply: { ok: true } }>(
    "/internal/bridge-token/validate",
    { preHandler: requireRelayAuth },
    async (request) => {
      const bodyResult = validateBridgeTokenBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      let parsedToken: unknown;
      try {
        parsedToken = tokenService.verifyBridgeToken(bodyResult.data.bridgeToken);
      } catch (error) {
        throw new UnauthenticatedError({ debugMessage: "Bridge token verification failed", nestedError: error });
      }

      const payloadResult = bridgeTokenPayloadSchema.safeParse(parsedToken);
      if (!payloadResult.success) {
        throw new UnauthenticatedError({
          debugMessage: "Bridge token payload validation failed",
          nestedError: payloadResult.error.issues,
        });
      }
      if (
        payloadResult.data.userId !== bodyResult.data.userId ||
        payloadResult.data.bridgeId !== bodyResult.data.bridgeId
      ) {
        throw new UnauthenticatedError({ debugMessage: "Bridge token subject mismatch" });
      }

      const bridge = await bridgeService.findByIdForUser(bodyResult.data.bridgeId, bodyResult.data.userId);
      if (!bridge) {
        throw new NotFoundError({ debugMessage: "Bridge not found or revoked" });
      }

      return { ok: true };
    },
  );

  fastify.get<{ Reply: BridgesListReply }>("/auth/bridges", { preHandler: requireAuth }, async (request) => {
    const userId = getUserId(request);
    const bridges = await bridgeService.listForUser(userId);
    return { bridges };
  });

  fastify.delete<{ Params: { bridgeId: string }; Reply: { ok: true } }>(
    "/auth/bridges/:bridgeId",
    { preHandler: requireAuth },
    async (request) => {
      const paramResult = bridgeIdPathParamSchema.safeParse(request.params.bridgeId);
      if (!paramResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid bridgeId", nestedError: paramResult.error.issues });
      }

      const userId = getUserId(request);
      const revoked = await bridgeService.revokeForUser(userId, paramResult.data);
      if (!revoked) {
        throw new NotFoundError({ debugMessage: "Bridge not found or already revoked" });
      }
      return { ok: true };
    },
  );
};

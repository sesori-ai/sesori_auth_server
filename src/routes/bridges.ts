import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, NotFoundError, UnauthenticatedError } from "../lib/errors.js";
import {
  registerBridgeBodySchema,
  bridgeIdPathParamSchema,
  type BridgesListReply,
  type RegisterBridgeReply,
} from "../models/api.js";
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
};

export const bridgeRoutes: FastifyPluginAsync<BridgeRouteOptions> = async (fastify, opts) => {
  const { bridgeService, tokenService, requireAuth } = opts;

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

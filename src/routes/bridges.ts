import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, NotFoundError, UnauthenticatedError } from "../lib/errors.js";
import {
  registerBridgeBodySchema,
  bridgeIdPathParamSchema,
  type BridgeSummary,
  type BridgesListReply,
} from "../models/api.js";
import type { BridgeService } from "../services/bridge-service.js";

function getUserId(request: FastifyRequest): string {
  if (!request.user) throw new UnauthenticatedError();
  return request.user.userId;
}

export type BridgeRouteOptions = {
  bridgeService: BridgeService;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const bridgeRoutes: FastifyPluginAsync<BridgeRouteOptions> = async (fastify, opts) => {
  const { bridgeService, requireAuth } = opts;

  // Idempotent registration: an optional bridgeId that matches a non-revoked
  // bridge owned by the caller updates that bridge (200); otherwise a new
  // bridge is minted server-side (201).
  fastify.post<{ Body: unknown; Reply: BridgeSummary }>(
    "/auth/bridges",
    { preHandler: requireAuth },
    async (request, reply) => {
      const bodyResult = registerBridgeBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      const userId = getUserId(request);
      const { bridge, created } = await bridgeService.registerForUser(userId, bodyResult.data);
      reply.status(created ? 201 : 200);
      return bridge;
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

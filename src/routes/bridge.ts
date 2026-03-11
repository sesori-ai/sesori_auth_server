import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import {
  deregister,
  findByUser,
  heartbeat,
  register,
} from "../services/bridge-service.js";

const registerBodySchema = z.object({
  relayUrl: z.string(),
  roomCode: z.string(),
  publicKey: z.string(),
});

export const bridgeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/bridge/register",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const bodyResult = registerBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: bodyResult.error.errors,
        });
      }

      return register({
        userId: request.user!.userId,
        relayUrl: bodyResult.data.relayUrl,
        roomCode: bodyResult.data.roomCode,
        publicKey: bodyResult.data.publicKey,
      });
    }
  );

  fastify.post(
    "/bridge/heartbeat",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const updated = await heartbeat(request.user!.userId);
      if (!updated) {
        return reply.status(404).send({ error: "no_bridge_registered" });
      }

      return { ok: true };
    }
  );

  fastify.delete(
    "/bridge/deregister",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      await deregister(request.user!.userId);
      return { ok: true };
    }
  );

  fastify.get(
    "/bridge/mine",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const registration = await findByUser(request.user!.userId);
      if (!registration) {
        return reply.status(404).send({ error: "no_bridge_online" });
      }

      return registration;
    }
  );
};

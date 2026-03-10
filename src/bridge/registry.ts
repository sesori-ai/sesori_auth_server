import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { requireAuth } from "../middleware/auth.js";
import { bridgeRegistrations } from "../db/collections.js";

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

      const { relayUrl, roomCode, publicKey } = bodyResult.data;
      const userId = request.user!.userId;

      const result = await bridgeRegistrations().updateOne(
        { userId: new ObjectId(userId) },
        {
          $set: { relayUrl, roomCode, publicKey, lastHeartbeat: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );

      return { bridgeId: result.upsertedId?.toHexString() ?? userId };
    }
  );

  fastify.post(
    "/bridge/heartbeat",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = request.user!.userId;

      const updateResult = await bridgeRegistrations().updateOne(
        { userId: new ObjectId(userId) },
        { $set: { lastHeartbeat: new Date() } }
      );

      if (updateResult.matchedCount === 0) {
        return reply.status(404).send({ error: "no_bridge_registered" });
      }

      return { ok: true };
    }
  );

  fastify.delete(
    "/bridge/deregister",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = request.user!.userId;

      await bridgeRegistrations().deleteOne({ userId: new ObjectId(userId) });

      return { ok: true };
    }
  );

  fastify.get(
    "/bridge/mine",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = request.user!.userId;

      const doc = await bridgeRegistrations().findOne({
        userId: new ObjectId(userId),
      });

      if (!doc) {
        return reply.status(404).send({ error: "no_bridge_online" });
      }

      const ttlSeconds = 60;
      const age = (Date.now() - doc.lastHeartbeat.getTime()) / 1000;
      if (age > ttlSeconds) {
        return reply.status(404).send({ error: "no_bridge_online" });
      }

      return {
        bridgeId: doc._id.toHexString(),
        relayUrl: doc.relayUrl,
        roomCode: doc.roomCode,
        publicKey: doc.publicKey,
      };
    }
  );
};

import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ObjectId } from "mongodb";
import {
  verifyToken,
  signAccessToken,
  signRefreshToken,
  getPublicKey,
} from "./jwt.js";
import { refreshTokenPayloadSchema } from "./token-schemas.js";
import { users, oauthAccounts } from "../db/collections.js";
import { requireAuth } from "../middleware/auth.js";

const refreshBodySchema = z.object({
  refreshToken: z.string(),
});

export const tokenRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/auth/refresh", async (request, reply) => {
    const bodyResult = refreshBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: bodyResult.error.errors,
      });
    }

    const { refreshToken } = bodyResult.data;

    let userId: string;
    try {
      const raw = verifyToken(refreshToken);
      const payload = refreshTokenPayloadSchema.parse(raw);
      userId = payload.userId;
    } catch (e) {
      request.log.warn(e, "Refresh token verification failed");
      return reply.status(401).send({ error: "unauthorized" });
    }

    const userObjectId = new ObjectId(userId);

    const user = await users().findOne({ _id: userObjectId });
    if (!user) {
      return reply.status(401).send({ error: "unauthorized" });
    }

    const oauthAccount = await oauthAccounts().findOne({ userId: userObjectId });
    if (!oauthAccount) {
      return reply.status(401).send({ error: "unauthorized" });
    }

    const newAccessToken = signAccessToken({
      userId,
      provider: oauthAccount.provider,
      providerUserId: oauthAccount.providerUserId,
    });
    const newRefreshToken = signRefreshToken({ userId });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      user: {
        id: userId,
        provider: oauthAccount.provider,
        providerUserId: oauthAccount.providerUserId,
        providerUsername: oauthAccount.providerUsername,
      },
    };
  });

  fastify.get(
    "/auth/me",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.user!.userId;
      const userObjectId = new ObjectId(userId);

      const user = await users().findOne({ _id: userObjectId });
      if (!user) {
        return reply.status(404).send({ error: "User not found" });
      }

      const oauthAccount = await oauthAccounts().findOne({
        userId: userObjectId,
      });
      if (!oauthAccount) {
        return reply.status(404).send({ error: "User not found" });
      }

      return {
        user: {
          id: userId,
          provider: oauthAccount.provider,
          providerUserId: oauthAccount.providerUserId,
          providerUsername: oauthAccount.providerUsername,
        },
      };
    }
  );

  fastify.post(
    "/auth/logout",
    { preHandler: requireAuth },
    async (request, reply) => {
      return { success: true };
    }
  );

  fastify.get("/auth/public-key", async (request, reply) => {
    const key = getPublicKey();
    return reply.type("text/plain").send(key);
  });
};

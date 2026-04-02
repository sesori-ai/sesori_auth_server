import { FastifyPluginAsync, FastifyRequest } from "fastify";
import { BadRequestError } from "../lib/errors.js";
import { generateMetadataBodySchema } from "../models/api.js";
import type { GenerateMetadataBody, GenerateMetadataReply } from "../models/api.js";
import type { SessionMetadataService } from "../services/session-metadata-service.js";

export type SessionRouteOptions = {
  sessionMetadataService: SessionMetadataService;
  requireAuth: (request: FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
};

export const sessionRoutes: FastifyPluginAsync<SessionRouteOptions> = async (fastify, opts) => {
  const { sessionMetadataService, requireAuth } = opts;

  fastify.post<{ Body: GenerateMetadataBody; Reply: GenerateMetadataReply }>(
    "/sessions/generate-metadata",
    { preHandler: requireAuth },
    async (request) => {
      const bodyResult = generateMetadataBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      const userId = request.user!.userId.toString();

      const { title, branchName } = await sessionMetadataService.generateMetadata({
        userId,
        firstMessage: bodyResult.data.firstMessage,
      });

      return { title, branchName };
    },
  );
};

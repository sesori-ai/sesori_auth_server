import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, UnauthenticatedError } from "../lib/errors.js";
import type { ClientIpRequest } from "../lib/client-ip.js";
import { buildAccountRateLimitKey } from "../middleware/account-rate-limit-key.js";
import { submitFeedbackBodySchema } from "../models/feedback.js";
import type { FeedbackService } from "../services/feedback-service.js";
import type { TokenService } from "../services/token-service.js";

function getUserId(request: FastifyRequest): string {
  if (!request.user) {
    throw new UnauthenticatedError();
  }

  return request.user.userId;
}

// Every accepted submission inserts a document, so this bounds how fast one
// account can grow the collection. Real use is a handful of submissions ever;
// the prompt is rare and the settings entry is manual. The plugin counts per
// route, so the delete below has its own bucket.
const FEEDBACK_WRITE_MAX_PER_HOUR = 10;

export type FeedbackRouteOptions = {
  feedbackService: FeedbackService;
  tokenService: TokenService;
  resolveClientIp: (request: ClientIpRequest) => string;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const feedbackRoutes: FastifyPluginAsync<FeedbackRouteOptions> = async (fastify, opts) => {
  const { feedbackService, tokenService, resolveClientIp, requireAuth } = opts;

  const feedbackWriteRateLimit = {
    max: FEEDBACK_WRITE_MAX_PER_HOUR,
    timeWindow: "1 hour",
    keyGenerator: buildAccountRateLimitKey(tokenService, resolveClientIp),
  };

  // The message is never logged: it may hold pasted code or secrets. A 400
  // logs only the zod issues, which carry paths and limits but not the input.
  fastify.post<{ Body: unknown; Reply: { ok: true } }>(
    "/feedback",
    { preHandler: requireAuth, config: { rateLimit: feedbackWriteRateLimit } },
    async (request, reply) => {
      const bodyResult = submitFeedbackBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid feedback payload", nestedError: bodyResult.error.issues });
      }

      const userId = getUserId(request);
      await feedbackService.submit(userId, bodyResult.data);
      reply.status(201);
      return { ok: true };
    },
  );

  // Account-wide, for the account-deletion flow, like DELETE /auth/settings:
  // the account comes from the verified token and never from a caller-supplied
  // id. Idempotent, so an account that submitted nothing still returns 200.
  fastify.delete<{ Reply: { ok: true } }>(
    "/feedback",
    { preHandler: requireAuth, config: { rateLimit: feedbackWriteRateLimit } },
    async (request) => {
      const userId = getUserId(request);
      await feedbackService.deleteAllForUser(userId);
      return { ok: true };
    },
  );
};

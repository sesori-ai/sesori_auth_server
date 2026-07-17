import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, InternalServerError, UnauthenticatedError } from "../lib/errors.js";
import { createRequestCloseSignal } from "../lib/request-close-signal.js";
import {
  appClientStatusQuerySchema,
  appClientStatusReplySchema,
  type AppClientStatusQuery,
  type AppClientStatusReply,
} from "../models/api.js";
import {
  AppClientPresenceInitialReadTimeout,
  type AppClientPresenceService,
} from "../services/app-client-presence-service.js";

const APP_CLIENT_STATUS_WAIT_TIMEOUT_MS = 30_000;

export type AppClientRouteOptions = {
  appClientPresenceService: AppClientPresenceService;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const appClientRoutes: FastifyPluginAsync<AppClientRouteOptions> = async (fastify, opts) => {
  fastify.get<{ Querystring: AppClientStatusQuery; Reply: AppClientStatusReply }>(
    "/auth/app-clients/status",
    { preHandler: opts.requireAuth },
    async (request, reply) => {
      const queryResult = appClientStatusQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        throw new BadRequestError({
          debugMessage: "Invalid app-client status query",
          nestedError: queryResult.error.issues,
        });
      }

      const userId = getUserId(request);
      let registered: boolean | null;
      try {
        registered = queryResult.data.wait
          ? await opts.appClientPresenceService.waitForRegistration({
              userId,
              timeoutMs: APP_CLIENT_STATUS_WAIT_TIMEOUT_MS,
              abortSignal: createRequestCloseSignal({ request, reply }),
            })
          : await opts.appClientPresenceService.hasRegisteredClient({ userId });
      } catch (error) {
        if (error instanceof AppClientPresenceInitialReadTimeout) {
          throw new InternalServerError({ debugMessage: error.message });
        }
        throw error;
      }

      if (registered === null || !isClientConnectionOpen({ request, reply })) {
        return reply.hijack();
      }

      const candidateReply = { registered };
      const replyResult = appClientStatusReplySchema.safeParse(candidateReply);
      if (!replyResult.success) {
        throw new InternalServerError({
          debugMessage: "Invalid app-client status reply",
          nestedError: replyResult.error.issues,
        });
      }

      return replyResult.data;
    },
  );
};

function getUserId(request: FastifyRequest): string {
  if (!request.user) {
    throw new UnauthenticatedError();
  }
  return request.user.userId;
}

function isClientConnectionOpen(params: { request: FastifyRequest; reply: FastifyReply }): boolean {
  return !params.request.raw.destroyed && !params.request.socket.destroyed && !params.reply.raw.writableEnded;
}

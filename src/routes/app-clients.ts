/**
 * GET /auth/app-clients/status — authenticated endpoint reporting whether the
 * user has at least one registered app-client device token.
 *
 * Query:
 *   wait=true — hold the connection open (up to 30 s) and return as soon as a
 *   token registration commits. Omitted means an immediate read; any other
 *   value or unknown key is rejected by the strict query schema.
 *
 * Responses:
 *   200 { registered: boolean }
 *   400 { error: "bad_request" }           — invalid query
 *   401 { error: "unauthenticated" }
 *   500 { error: "internal_server_error" } — the initial read missed the 30 s
 *       deadline; unconfirmed absence is never reported as `false`
 *   503 { error: "service_restarting", retryable: true } — shutdown released
 *       the waiters before any read could confirm absence (wait=true only; an
 *       immediate read still answers, because its result is verified)
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, InternalServerError, ServiceRestartingError, UnauthenticatedError } from "../lib/errors.js";
import { createRequestCloseSignal, isClientConnectionOpen } from "../lib/request-close-signal.js";
import {
  appClientStatusQuerySchema,
  appClientStatusReplySchema,
  type AppClientStatusQuery,
  type AppClientStatusReply,
} from "../models/api.js";
import {
  AppClientPresenceInitialReadTimeout,
  AppClientPresenceShuttingDown,
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
        // The initial read never confirmed presence or absence — surface 500
        // rather than letting a false negative reach the app client.
        if (error instanceof AppClientPresenceInitialReadTimeout) {
          throw new InternalServerError({ debugMessage: error.message });
        }

        // Shutdown released the waiters, so no read stands behind an answer
        // here either. Refuse retryably instead of inventing an absence.
        if (error instanceof AppClientPresenceShuttingDown) {
          throw new ServiceRestartingError({ debugMessage: error.message });
        }

        throw error;
      }

      // null means the client disconnected (abort fired before resolution).
      // Hijack so no late payload is written to a closed socket.
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

/**
 * `GET /auth/session/status` — long-poll endpoint for the OAuth pending-auth flow.
 *
 * Required header:
 *   X-Sesori-Session-Token: 64 hex chars (client-generated, single-use)
 *
 * Responses:
 *   200 { status: "pending" }                                  — long-poll timed out, still pending
 *   200 { status: "complete", accessToken, refreshToken, user } — tokens delivered & consumed; subsequent polls return 404
 *   200 { status: "denied" }
 *   200 { status: "error", message }
 *   400 { error: "bad_request" }                                — missing/invalid session-token header
 *   404 { error: "not_found" }                                  — unknown OR already-consumed (deliberately conflated, see CQ-11)
 *   410 { status: "expired" }
 *
 * CQ-11 (404 conflation): once `complete` has been consumed by a previous
 * poll, the session entry is deleted. A subsequent poll with the same token
 * cannot distinguish "session never existed" from "session was just
 * consumed". Both return 404 — this is intentional. The tokens have already
 * been delivered exactly once; revealing that a session "existed" would
 * leak no useful information to a legitimate client and could aid token
 * enumeration. Clients should treat 404 as terminal and reset their flow.
 */

import { FastifyPluginAsync, type FastifyReply, type FastifyRequest } from "fastify";
import { NotFoundError } from "../../lib/errors.js";
import type {
  AuthSessionStatusCompleteReply,
  AuthSessionStatusDeniedReply,
  AuthSessionStatusErrorReply,
  AuthSessionStatusExpiredReply,
  AuthSessionStatusPendingReply,
  AuthSessionStatusReply,
} from "../../models/api.js";
import { PendingAuthStatus, PendingAuthStore, type PendingAuthSession } from "../../services/pending-auth-store.js";
import { parseSessionTokenHeader } from "./init.js";

const DEFAULT_STATUS_POLL_TIMEOUT_MS = 30_000;

export type SessionStatusRouteOptions = {
  pendingAuthStore: PendingAuthStore;
  /** Long-poll cap. Defaults to 30s; production wires this from `config.PENDING_AUTH_POLL_TIMEOUT_MS`. */
  statusPollTimeoutMs?: number;
};

export const sessionStatusRoutes: FastifyPluginAsync<SessionStatusRouteOptions> = async (fastify, opts) => {
  const { pendingAuthStore, statusPollTimeoutMs = DEFAULT_STATUS_POLL_TIMEOUT_MS } = opts;

  fastify.get<{ Reply: AuthSessionStatusReply }>("/auth/session/status", async (request, reply) => {
    const sessionToken = parseSessionTokenHeader(request.headers["x-sesori-session-token"]);
    const tokenHash = PendingAuthStore.hashToken(sessionToken);

    const session = pendingAuthStore.getSessionByTokenHash(tokenHash);
    if (!session) {
      throw new NotFoundError({ debugMessage: "Pending auth session not found" });
    }

    const nextSession = await waitForTerminalOrTimeout({
      pendingAuthStore,
      tokenHash,
      session,
      statusPollTimeoutMs,
      abortSignal: createRequestCloseSignal({ request, reply }),
    });

    if (!nextSession) {
      if (!isClientConnectionOpen({ request, reply })) {
        return reply.hijack();
      }
      throw new NotFoundError({ debugMessage: "Pending auth session no longer exists" });
    }

    switch (nextSession.status) {
      case PendingAuthStatus.Pending:
      case PendingAuthStatus.AwaitingConfirmation:
        return createPendingReply();
      case PendingAuthStatus.Complete:
        // Consume only when a live connection is still available for delivery.
        // This avoids deleting tokens for Android clients whose OS aborted the
        // in-flight long-poll while the server-side waiter was still resolving.
        // A tiny race remains if the socket dies after this check but before the
        // kernel flushes the response; closing that would require an explicit
        // client ack, which would create a broader replay/read window.
        if (!isClientConnectionOpen({ request, reply })) {
          return reply.hijack();
        }
        return createCompleteReply({ pendingAuthStore, tokenHash });
      case PendingAuthStatus.Denied:
        return createDeniedReply();
      case PendingAuthStatus.Expired:
        return reply.status(410).send(createExpiredReply());
      case PendingAuthStatus.Error:
        return createErrorReply({ message: nextSession.errorMessage ?? "authentication_failed" });
      case PendingAuthStatus.Consumed:
        // CQ-11: tokens were already delivered to a prior poll. We deliberately
        // return the same 404 used for "unknown session" to avoid leaking
        // session existence after consumption.
        throw new NotFoundError({ debugMessage: "Pending auth session already consumed" });
    }
  });
};

/**
 * Iteratively waits for the session to transition out of `pending` /
 * `awaiting_confirmation` (which both surface as `pending` to clients).
 * Returns the session at the moment of resolution, or null if the session
 * was deleted. The waiter cap is the smaller of `statusPollTimeoutMs` and
 * the session's remaining TTL — see `PendingAuthStore.waitForStatusChange`.
 */
async function waitForTerminalOrTimeout(params: {
  pendingAuthStore: PendingAuthStore;
  tokenHash: string;
  session: PendingAuthSession;
  statusPollTimeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<PendingAuthSession | null> {
  let session = params.session;
  if (session.status !== PendingAuthStatus.Pending && session.status !== PendingAuthStatus.AwaitingConfirmation) {
    return session;
  }

  const deadline = Date.now() + params.statusPollTimeoutMs;

  while (session.status === PendingAuthStatus.Pending || session.status === PendingAuthStatus.AwaitingConfirmation) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return session;
    }

    const nextSession = await params.pendingAuthStore.waitForStatusChange(params.tokenHash, remainingMs, {
      abortSignal: params.abortSignal,
    });
    if (!nextSession) {
      return null;
    }

    session = nextSession;
    if (session.status !== PendingAuthStatus.AwaitingConfirmation) {
      return session;
    }
  }

  return session;
}

function createRequestCloseSignal(params: { request: FastifyRequest; reply: FastifyReply }): AbortSignal {
  const controller = new AbortController();

  // If the connection is already gone, abort immediately without registering
  // listeners that will never fire.
  if (params.request.raw.destroyed || params.request.socket.destroyed || params.reply.raw.writableEnded) {
    controller.abort();
    return controller.signal;
  }

  const abortIfUndelivered = () => {
    if (!params.reply.raw.writableEnded) {
      controller.abort();
    }
  };
  const removeAbortListener = () => {
    params.request.socket.off("close", abortIfUndelivered);
    params.reply.raw.off("close", abortIfUndelivered);
    params.reply.raw.off("finish", removeAbortListener);
    params.reply.raw.off("close", removeAbortListener);
  };

  // Use the underlying socket close and response close events rather than
  // request.raw 'close', which can also fire when the request stream ends on a
  // healthy keep-alive connection.
  params.request.socket.once("close", abortIfUndelivered);
  params.reply.raw.once("close", abortIfUndelivered);
  params.reply.raw.once("finish", removeAbortListener);
  params.reply.raw.once("close", removeAbortListener);

  return controller.signal;
}

function isClientConnectionOpen(params: { request: FastifyRequest; reply: FastifyReply }): boolean {
  return !params.request.raw.destroyed && !params.request.socket.destroyed && !params.reply.raw.writableEnded;
}

function createPendingReply(): AuthSessionStatusPendingReply {
  return { status: "pending" };
}

function createCompleteReply(params: {
  pendingAuthStore: PendingAuthStore;
  tokenHash: string;
}): AuthSessionStatusCompleteReply {
  const completion = params.pendingAuthStore.consumeCompletion(params.tokenHash);
  if (!completion) {
    throw new NotFoundError({ debugMessage: "Pending auth session completion already consumed" });
  }

  return {
    status: "complete",
    accessToken: completion.tokens.accessToken,
    refreshToken: completion.tokens.refreshToken,
    user: completion.user,
  };
}

function createDeniedReply(): AuthSessionStatusDeniedReply {
  return { status: "denied" };
}

function createExpiredReply(): AuthSessionStatusExpiredReply {
  return { status: "expired" };
}

function createErrorReply(params: { message: string }): AuthSessionStatusErrorReply {
  return {
    status: "error",
    message: params.message,
  };
}

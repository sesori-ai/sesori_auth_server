import { FastifyPluginAsync } from "fastify";
import { NotFoundError } from "../../lib/errors.js";
import type {
  AuthSessionStatusCompleteReply,
  AuthSessionStatusDeniedReply,
  AuthSessionStatusErrorReply,
  AuthSessionStatusExpiredReply,
  AuthSessionStatusPendingReply,
  AuthSessionStatusReply,
} from "../../models/api.js";
import { PendingAuthStore, type PendingAuthSession } from "../../services/pending-auth-store.js";
import { parseSessionTokenHeader } from "./init.js";

const DEFAULT_STATUS_POLL_TIMEOUT_MS = 30_000;

export type SessionStatusRouteOptions = {
  pendingAuthStore: PendingAuthStore;
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
    });

    if (!nextSession) {
      throw new NotFoundError({ debugMessage: "Pending auth session no longer exists" });
    }

    switch (nextSession.status) {
      case "pending":
      case "awaiting_confirmation":
        return createPendingReply();
      case "complete":
        return createCompleteReply({ pendingAuthStore, tokenHash });
      case "denied":
        return createDeniedReply();
      case "expired":
        return reply.status(410).send(createExpiredReply());
      case "error":
        return createErrorReply({ message: nextSession.errorMessage ?? "authentication_failed" });
      case "consumed":
        throw new NotFoundError({ debugMessage: "Pending auth session already consumed" });
    }
  });
};

async function waitForTerminalOrTimeout(params: {
  pendingAuthStore: PendingAuthStore;
  tokenHash: string;
  session: PendingAuthSession;
  statusPollTimeoutMs: number;
}): Promise<PendingAuthSession | null> {
  let session = params.session;
  if (session.status !== "pending" && session.status !== "awaiting_confirmation") {
    return session;
  }

  const deadline = Date.now() + params.statusPollTimeoutMs;

  while (session.status === "pending" || session.status === "awaiting_confirmation") {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return session;
    }

    const nextSession = await params.pendingAuthStore.waitForStatusChange(params.tokenHash, remainingMs);
    if (!nextSession) {
      return null;
    }

    session = nextSession;
    if (session.status !== "awaiting_confirmation") {
      return session;
    }
  }

  return session;
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

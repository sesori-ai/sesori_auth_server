import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Fastify, { type FastifyInstance, type InjectOptions, type LightMyRequestResponse } from "fastify";
import { ApiError } from "../../src/lib/errors.js";
import { sessionStatusRoutes } from "../../src/routes/auth/session-status.js";
import { PendingAuthStore } from "../../src/services/pending-auth-store.js";
import { OAuthProviderName } from "../../src/types/oauth.js";

const VALID_SESSION_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const INVALID_SESSION_TOKEN = "not-a-valid-session-token";
const TEST_USER = {
  id: "user-123",
  provider: "github",
  providerUserId: "provider-user-123",
  providerUsername: "sesori-user",
};
const TEST_TOKENS = {
  accessToken: "access-token-123",
  refreshToken: "refresh-token-123",
};

describe("GET /auth/session/status", () => {
  let app: FastifyInstance;
  let pendingAuthStore: PendingAuthStore;

  beforeEach(async () => {
    pendingAuthStore = new PendingAuthStore({ sessionTtlMs: 120_000 });
    app = Fastify({ disableRequestLogging: true });

    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply.status(error.errorCode).send({ error: error.message, ...error.responseBody });
      }

      return reply.status(500).send({ error: "internal_server_error" });
    });

    await app.register(sessionStatusRoutes, {
      pendingAuthStore,
      statusPollTimeoutMs: 25,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns pending after the long-poll timeout when the session stays pending", async () => {
    createPendingSession({ sessionToken: VALID_SESSION_TOKEN });

    const startedAt = Date.now();
    const res = await injectWithKeepAlive({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "pending" });
    assert.ok(Date.now() - startedAt >= 20);
  });

  it("returns a completed auth payload immediately and consumes it", async () => {
    const tokenHash = createPendingSession({ sessionToken: VALID_SESSION_TOKEN });
    pendingAuthStore.completeSession({ tokenHash, tokens: TEST_TOKENS, user: TEST_USER });

    const res = await injectWithKeepAlive({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      status: "complete",
      accessToken: TEST_TOKENS.accessToken,
      refreshToken: TEST_TOKENS.refreshToken,
      user: TEST_USER,
    });
    assert.equal(pendingAuthStore.getSessionByTokenHash(tokenHash), null);
  });

  it("returns 404 after a completion has already been consumed", async () => {
    const tokenHash = createPendingSession({ sessionToken: VALID_SESSION_TOKEN });
    pendingAuthStore.completeSession({ tokenHash, tokens: TEST_TOKENS, user: TEST_USER });

    const firstResponse = await injectWithKeepAlive({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
    });
    const secondResponse = await injectWithKeepAlive({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
    });

    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 404);
    assert.equal(secondResponse.json<{ error: string }>().error, "not_found");
  });

  it("keeps a completed session readable once when the waiting client disconnects before delivery", async () => {
    const tokenHash = createPendingSession({ sessionToken: VALID_SESSION_TOKEN });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const pendingRequest = openStatusRequest({ origin, sessionToken: VALID_SESSION_TOKEN });

    await delay(10);
    pendingRequest.destroy();
    await pendingRequest.closed;

    pendingAuthStore.completeSession({ tokenHash, tokens: TEST_TOKENS, user: TEST_USER });
    await delay(10);

    assert.equal(pendingAuthStore.getSessionByTokenHash(tokenHash)?.status, "complete");

    const retryResponse = await injectWithKeepAlive({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
    });
    const replayResponse = await injectWithKeepAlive({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
    });

    assert.equal(retryResponse.statusCode, 200);
    assert.deepEqual(retryResponse.json(), {
      status: "complete",
      accessToken: TEST_TOKENS.accessToken,
      refreshToken: TEST_TOKENS.refreshToken,
      user: TEST_USER,
    });
    assert.equal(replayResponse.statusCode, 404);
    assert.equal(replayResponse.json<{ error: string }>().error, "not_found");
  });

  it("returns denied when the pending session is denied during long-polling", async () => {
    const tokenHash = createPendingSession({ sessionToken: VALID_SESSION_TOKEN });

    const responsePromise = injectWithKeepAlive({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
    });

    setTimeout(() => {
      pendingAuthStore.denySession(tokenHash);
    }, 10);

    const res = await responsePromise;

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "denied" });
  });

  it("keeps waiting through awaiting_confirmation and returns pending at timeout", async () => {
    const tokenHash = createPendingSession({ sessionToken: VALID_SESSION_TOKEN });

    const responsePromise = injectWithKeepAlive({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
    });

    setTimeout(() => {
      pendingAuthStore.markAwaitingConfirmation(tokenHash);
    }, 10);

    const startedAt = Date.now();
    const res = await responsePromise;

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "pending" });
    assert.ok(Date.now() - startedAt >= 20);
  });

  it("returns 410 when the pending session expires while waiting", async () => {
    const tokenHash = createPendingSession({ sessionToken: VALID_SESSION_TOKEN });
    const session = pendingAuthStore.getSessionByTokenHash(tokenHash);
    assert.ok(session);

    const responsePromise = injectWithKeepAlive({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
    });

    setTimeout(() => {
      pendingAuthStore.expireExpiredSessions(session.expiresAt);
    }, 10);

    const res = await responsePromise;

    assert.equal(res.statusCode, 410);
    assert.deepEqual(res.json(), { status: "expired" });
  });

  it("returns error details when the pending session fails during long-polling", async () => {
    const tokenHash = createPendingSession({ sessionToken: VALID_SESSION_TOKEN });

    const responsePromise = injectWithKeepAlive({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
    });

    setTimeout(() => {
      pendingAuthStore.failSession({ tokenHash, errorMessage: "oauth_exchange_failed" });
    }, 10);

    const res = await responsePromise;

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      status: "error",
      message: "oauth_exchange_failed",
    });
  });

  it("returns 400 for missing or invalid session-token headers", async () => {
    const missingHeaderResponse = await app.inject({
      method: "GET",
      url: "/auth/session/status",
    });
    const invalidHeaderResponse = await app.inject({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": INVALID_SESSION_TOKEN },
    });

    assert.equal(missingHeaderResponse.statusCode, 400);
    assert.equal(missingHeaderResponse.json<{ error: string }>().error, "bad_request");
    assert.equal(invalidHeaderResponse.statusCode, 400);
    assert.equal(invalidHeaderResponse.json<{ error: string }>().error, "bad_request");
  });

  it("returns 404 when the session token does not map to a pending auth session", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.json<{ error: string }>().error, "not_found");
  });

  it("only one of two concurrent pollers receives the tokens (QA-3)", async () => {
    const tokenHash = createPendingSession({ sessionToken: VALID_SESSION_TOKEN });
    pendingAuthStore.completeSession({ tokenHash, tokens: TEST_TOKENS, user: TEST_USER });

    const [a, b] = await Promise.all([
      injectWithKeepAlive({
        method: "GET",
        url: "/auth/session/status",
        headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
      }),
      injectWithKeepAlive({
        method: "GET",
        url: "/auth/session/status",
        headers: { "x-sesori-session-token": VALID_SESSION_TOKEN },
      }),
    ]);

    const completed = [a, b].filter((r) => r.statusCode === 200 && r.json().status === "complete");
    assert.equal(completed.length, 1, "exactly one poller must consume the tokens");
    const failed = [a, b].filter((r) => r.statusCode === 404);
    assert.equal(failed.length, 1, "the losing poller must see 404 (CQ-11 conflation)");
  });

  function createPendingSession(params: { sessionToken: string }): string {
    const tokenHash = PendingAuthStore.hashToken(params.sessionToken);
    pendingAuthStore.createSession({
      tokenHash,
      provider: OAuthProviderName.Github,
      pkceVerifier: "pkce-verifier",
      state: `state-${tokenHash}`,
    });

    return tokenHash;
  }

  async function injectWithKeepAlive(options: InjectOptions): Promise<LightMyRequestResponse> {
    // Keep-alive prevents Node from exiting while the long-poll suspends on
    // an internal timer (the only pending handle during waitForStatusChange).
    // Without this, node:test can drain the event loop before fastify.inject()
    // resolves, surfacing as flaky/aborted tests.
    const keepAlive = setInterval(() => undefined, 1_000);

    try {
      return await app.inject(options);
    } finally {
      clearInterval(keepAlive);
    }
  }

  function openStatusRequest(params: { origin: string; sessionToken: string }): {
    destroy: () => void;
    closed: Promise<void>;
  } {
    const request = http.request(new URL("/auth/session/status", params.origin), {
      method: "GET",
      headers: { "x-sesori-session-token": params.sessionToken },
    });
    const closed = new Promise<void>((resolve) => {
      request.once("close", resolve);
      request.once("error", () => resolve());
    });
    request.end();

    return {
      destroy: () => request.destroy(),
      closed,
    };
  }

  async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "../../src/config.js";
import type { GithubClient } from "../../src/clients/auth/github-client.js";
import type { GoogleClient } from "../../src/clients/auth/google-client.js";
import { ApiError } from "../../src/lib/errors.js";
import { StateStore } from "../../src/lib/state-store.js";
import { githubRoutes } from "../../src/routes/auth/github.js";
import { googleRoutes } from "../../src/routes/auth/google.js";
import { PendingAuthStore } from "../../src/services/pending-auth-store.js";
import type { AuthService } from "../../src/services/auth-service.js";

const VALID_GITHUB_SESSION_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const VALID_GOOGLE_SESSION_TOKEN = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const VALID_CODE_CHALLENGE = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const VALID_REDIRECT_URI = "myapp://oauth/callback";

describe("OAuth init routes", () => {
  let app: FastifyInstance;
  let pendingAuthStore: PendingAuthStore;

  before(async () => {
    app = Fastify({ disableRequestLogging: true });
    pendingAuthStore = new PendingAuthStore();

    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply.status(error.errorCode).send({ error: error.message, ...error.responseBody });
      }

      return reply.status(500).send({ error: "internal_server_error" });
    });

    const config = {
      GITHUB_CLIENT_ID: "test-github-client-id",
      GITHUB_CLIENT_SECRET: "test-github-client-secret",
      GOOGLE_CLIENT_ID: "test-google-client-id",
      GOOGLE_CLIENT_SECRET: "test-google-client-secret",
      ALLOWED_REDIRECT_URIS: [VALID_REDIRECT_URI],
    } as Config;

    const authService = {} as AuthService;
    const githubClient = {} as GithubClient;
    const googleClient = {} as GoogleClient;
    const stateStore = new StateStore();

    await app.register(githubRoutes, {
      config,
      authService,
      stateStore,
      githubClient,
      pendingAuthStore,
    });
    await app.register(googleRoutes, {
      config,
      authService,
      stateStore,
      googleClient,
      pendingAuthStore,
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("creates a pending GitHub auth session and returns backend-callback init metadata", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/github/init",
      headers: {
        "content-type": "application/json",
        "x-sesori-session-token": VALID_GITHUB_SESSION_TOKEN,
      },
      payload: JSON.stringify({ clientType: "bridge_macos" }),
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{ authUrl: string; state: string; userCode: string; expiresIn: number }>();
    const authUrl = new URL(body.authUrl);
    assert.equal(authUrl.origin, "https://github.com");
    assert.equal(authUrl.pathname, "/login/oauth/authorize");
    assert.equal(authUrl.searchParams.get("redirect_uri"), "https://api.sesori.com/auth/github/callback");
    assert.equal(authUrl.searchParams.get("state"), body.state);
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    assert.match(body.state, /^[a-f0-9]{64}$/i);
    assert.match(body.userCode, /^[A-Z0-9]{4}$/);
    assert.ok(body.expiresIn > 0 && body.expiresIn <= 300);

    const pendingSession = pendingAuthStore.getSession(PendingAuthStore.hashToken(VALID_GITHUB_SESSION_TOKEN));
    assert.ok(pendingSession);
    assert.equal(pendingSession?.state, body.state);
    assert.equal(pendingSession?.provider, "github");
    assert.equal(pendingSession?.userCode, body.userCode);
    assert.match(pendingSession?.pkceVerifier ?? "", /^[A-Za-z0-9_-]{43,128}$/);
    assert.notEqual(authUrl.searchParams.get("code_challenge"), pendingSession?.pkceVerifier);
  });

  it("creates a pending Google auth session and returns backend-callback init metadata", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/google/init",
      headers: {
        "content-type": "application/json",
        "x-sesori-session-token": VALID_GOOGLE_SESSION_TOKEN,
      },
      payload: JSON.stringify({ clientType: "app_android" }),
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{ authUrl: string; state: string; userCode: string; expiresIn: number }>();
    const authUrl = new URL(body.authUrl);
    assert.equal(authUrl.origin, "https://accounts.google.com");
    assert.equal(authUrl.pathname, "/o/oauth2/v2/auth");
    assert.equal(authUrl.searchParams.get("redirect_uri"), "https://api.sesori.com/auth/google/callback");
    assert.equal(authUrl.searchParams.get("response_type"), "code");
    assert.equal(authUrl.searchParams.get("state"), body.state);
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    assert.match(body.state, /^[a-f0-9]{64}$/i);
    assert.match(body.userCode, /^[A-Z0-9]{4}$/);
    assert.ok(body.expiresIn > 0 && body.expiresIn <= 300);

    const pendingSession = pendingAuthStore.getSession(PendingAuthStore.hashToken(VALID_GOOGLE_SESSION_TOKEN));
    assert.ok(pendingSession);
    assert.equal(pendingSession?.state, body.state);
    assert.equal(pendingSession?.provider, "google");
    assert.equal(pendingSession?.userCode, body.userCode);
    assert.match(pendingSession?.pkceVerifier ?? "", /^[A-Za-z0-9_-]{43,128}$/);
    assert.notEqual(authUrl.searchParams.get("code_challenge"), pendingSession?.pkceVerifier);
  });

  it("returns 400 when the session token header is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/github/init",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ clientType: "bridge" }),
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json<{ error: string }>().error, "bad_request");
  });

  it("returns 400 when clientType is invalid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/google/init",
      headers: {
        "content-type": "application/json",
        "x-sesori-session-token": VALID_GOOGLE_SESSION_TOKEN,
      },
      payload: JSON.stringify({ clientType: "desktop" }),
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json<{ error: string }>().error, "bad_request");
  });

  it("keeps the legacy GET GitHub init endpoint working", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/auth/github?redirect_uri=${encodeURIComponent(VALID_REDIRECT_URI)}&code_challenge=${VALID_CODE_CHALLENGE}`,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{ authUrl: string; state: string }>();
    const authUrl = new URL(body.authUrl);
    assert.equal(authUrl.searchParams.get("redirect_uri"), VALID_REDIRECT_URI);
    assert.equal(authUrl.searchParams.get("code_challenge"), VALID_CODE_CHALLENGE);
    assert.equal(authUrl.searchParams.get("state"), body.state);
  });
});

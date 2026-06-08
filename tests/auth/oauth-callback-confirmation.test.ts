import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "../../src/config.js";
import { StateStore } from "../../src/lib/state-store.js";
import { buildApp, type AppServices } from "../../src/server.js";
import { PendingAuthStore } from "../../src/services/pending-auth-store.js";
import { OAuthProviderName, type OAuthExchangeParams, type OAuthIdentity } from "../../src/types/oauth.js";
import { FakeOAuthClient } from "../helpers/fake-oauth-client.js";

const VALID_SESSION_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_TOKENS = {
  accessToken: "access-token-123",
  refreshToken: "refresh-token-123",
};
const TEST_IDENTITY: OAuthIdentity = {
  providerUserId: "provider-user-id",
  providerUsername: "provider-username",
  email: "provider@example.com",
};

class RecordingOAuthClient extends FakeOAuthClient {
  lastParams: OAuthExchangeParams | null = null;

  constructor(identity: OAuthIdentity) {
    super(identity);
  }

  protected override async exchangeCode(params: OAuthExchangeParams) {
    this.lastParams = params;
    return await super.exchangeCode(params);
  }
}

function createTestConfig(): Config {
  return {
    PORT: 3001,
    AUTH_BASE_URL: "https://api.sesori.com",
    PENDING_AUTH_MAX_SESSIONS: 10_000,
    PENDING_AUTH_POLL_TIMEOUT_MS: 30_000,
    MONGODB_URI: "mongodb://localhost:27017/auth-backend-test",
    JWT_PRIVATE_KEY: "test-private-key",
    JWT_PUBLIC_KEY: "test-public-key",
    GITHUB_CLIENT_ID: "test-github-client-id",
    GITHUB_CLIENT_SECRET: "test-github-client-secret",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    APPLE_CLIENT_ID: "test-apple-client-id",
    APPLE_IOS_CLIENT_ID: "test.ios.bundle",
    APPLE_TEAM_ID: "TESTTEAM",
    APPLE_KEY_ID: "TESTKEY",
    APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\ntestkey\n-----END PRIVATE KEY-----\n",
    ALLOWED_REDIRECT_URIS: ["myapp://oauth/callback", "https://app.example.com/oauth/callback"],
    RELAY_URL: "ws://localhost:8080",
    RELAY_WEBHOOK_SECRET: "test-relay-secret",
    OPENAI_API_KEY: "test-openai-api-key",
    OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
    OPENAI_METADATA_MODEL: "gpt-5-nano",
    FCM_SA_JSON: {
      type: "service_account",
      project_id: "test-project",
      private_key_id: "test-key-id",
      private_key: "-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----\n",
      client_email: "test@test-project.iam.gserviceaccount.com",
      client_id: "123456789",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url:
        "https://www.googleapis.com/robot/v1/metadata/x509/test%40test-project.iam.gserviceaccount.com",
      universe_domain: "googleapis.com",
    },
    DAILY_TRANSCRIPTION_LIMIT_SECONDS: 3600,
  };
}

function createTestServices(params: {
  pendingAuthStore: PendingAuthStore;
  githubClient?: RecordingOAuthClient;
  googleClient?: RecordingOAuthClient;
}): AppServices {
  const githubClient = params.githubClient ?? new RecordingOAuthClient(TEST_IDENTITY);
  const googleClient = params.googleClient ?? new RecordingOAuthClient(TEST_IDENTITY);

  const authService = {
    async authenticateOAuth(
      providerName: OAuthProviderName,
      providerClient: RecordingOAuthClient,
      exchange: OAuthExchangeParams,
    ) {
      const identity = await providerClient.authenticate(exchange);

      return {
        ...TEST_TOKENS,
        user: {
          id: `${providerName}-user-123`,
          provider: providerName,
          providerUserId: identity.providerUserId,
          providerUsername: identity.providerUsername,
        },
      };
    },
  } as AppServices["authService"];

  return {
    config: createTestConfig(),
    authService,
    bridgeService: {} as AppServices["bridgeService"],
    tokenService: {} as AppServices["tokenService"],
    voiceService: {} as AppServices["voiceService"],
    sessionMetadataService: {} as AppServices["sessionMetadataService"],
    installScriptService: {} as AppServices["installScriptService"],
    legalDocumentService: {} as AppServices["legalDocumentService"],
    deviceTokenRepo: {} as AppServices["deviceTokenRepo"],
    notificationService: {} as AppServices["notificationService"],
    bridgeStateTracker: {} as AppServices["bridgeStateTracker"],
    stateStore: new StateStore(),
    pendingAuthStore: params.pendingAuthStore,
    githubClient: githubClient as unknown as AppServices["githubClient"],
    googleClient: googleClient as unknown as AppServices["googleClient"],
    appleClient: githubClient as unknown as AppServices["appleClient"],
    appleNativeVerifier: {} as AppServices["appleNativeVerifier"],
  };
}

describe("OAuth callback confirmation flow", () => {
  let app: FastifyInstance;
  let pendingAuthStore: PendingAuthStore;
  let githubClient: RecordingOAuthClient;

  before(async () => {
    pendingAuthStore = new PendingAuthStore({ sessionTtlMs: 120_000 });
    githubClient = new RecordingOAuthClient(TEST_IDENTITY);
    app = await buildApp(
      createTestServices({
        pendingAuthStore,
        githubClient,
      }),
    );
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("renders a Sesori confirmation page with the pending user code", async () => {
    const session = createPendingSession({ provider: OAuthProviderName.Github });

    const res = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=test-code&state=${session.state}`,
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /^text\/html/);
    assert.match(res.body, /Confirm Sesori sign-in/);
    assert.match(res.body, new RegExp(session.userCode));
    assert.match(res.body, /Confirm/);

    const updatedSession = pendingAuthStore.getSessionByTokenHash(session.tokenHash);
    assert.equal(updatedSession?.status, "awaiting_confirmation");
    assert.deepEqual(githubClient.lastParams, {
      code: "test-code",
      codeVerifier: session.pkceVerifier,
      redirectUri: "https://api.sesori.com/auth/github/callback",
      clientId: "test-github-client-id",
      clientSecret: "test-github-client-secret",
    });
  });

  it("completes the pending session only after explicit confirmation", async () => {
    const session = createPendingSession({ provider: OAuthProviderName.Github, tokenSuffix: "1" });

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=test-code-2&state=${session.state}`,
    });
    assert.equal(callbackResponse.statusCode, 200);

    const waitingSession = pendingAuthStore.getSessionByTokenHash(session.tokenHash);
    assert.equal(waitingSession?.status, "awaiting_confirmation");

    const confirmResponse = await app.inject({
      method: "POST",
      url: "/auth/github/callback/confirm",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ state: session.state, action: "confirm" }),
    });

    assert.equal(confirmResponse.statusCode, 200);
    assert.match(confirmResponse.body, /Sign-in confirmed/);

    const statusResponse = await app.inject({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": session.sessionToken },
    });

    assert.equal(statusResponse.statusCode, 200);
    assert.deepEqual(statusResponse.json(), {
      status: "complete",
      accessToken: TEST_TOKENS.accessToken,
      refreshToken: TEST_TOKENS.refreshToken,
      user: {
        id: "github-user-123",
        provider: "github",
        providerUserId: TEST_IDENTITY.providerUserId,
        providerUsername: TEST_IDENTITY.providerUsername,
      },
    });
  });

  it("does not expose the raw session token in the confirmation HTML", async () => {
    const session = createPendingSession({ provider: OAuthProviderName.Github, tokenSuffix: "3" });

    const res = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=test-code&state=${session.state}`,
    });

    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes(session.sessionToken), "HTML must not contain the raw session token");
    assert.ok(!res.body.includes(session.tokenHash), "HTML must not contain the token hash");
  });

  it("returns an error page for an invalid callback state", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/github/callback?code=test-code&state=invalid-state",
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Invalid sign-in callback/);
  });

  it("denies the session when the provider returns access_denied", async () => {
    const session = createPendingSession({ provider: OAuthProviderName.Github, tokenSuffix: "4" });

    const res = await app.inject({
      method: "GET",
      url: `/auth/github/callback?error=access_denied&state=${session.state}`,
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Sign-in cancelled/);

    const updatedSession = pendingAuthStore.getSessionByTokenHash(session.tokenHash);
    assert.equal(updatedSession?.status, "denied");
  });

  it("returns an expired page when the callback state no longer resolves", async () => {
    // Use deterministic `now` injection (no real timers) so this test isn't
    // flaky on slow CI runners. The store is constructed first; we advance
    // time past the TTL before calling the route.
    let currentTime = new Date("2026-05-15T12:00:00.000Z");
    const shortLivedStore = new PendingAuthStore({ sessionTtlMs: 1_000, now: () => currentTime });
    const shortLivedClient = new RecordingOAuthClient(TEST_IDENTITY);
    const shortLivedApp = await buildApp(
      createTestServices({
        pendingAuthStore: shortLivedStore,
        githubClient: shortLivedClient,
      }),
    );
    await shortLivedApp.ready();

    try {
      const session = createPendingSession({
        provider: OAuthProviderName.Github,
        store: shortLivedStore,
        tokenSuffix: "2",
      });
      currentTime = new Date(currentTime.getTime() + 5_000);

      const res = await shortLivedApp.inject({
        method: "GET",
        url: `/auth/github/callback?code=test-code&state=${session.state}`,
      });

      assert.equal(res.statusCode, 410);
      assert.match(res.body, /Sign-in request expired/);
    } finally {
      await shortLivedApp.close();
    }
  });

  it("denies the session when the user clicks Cancel on the confirmation page", async () => {
    const session = createPendingSession({ provider: OAuthProviderName.Github, tokenSuffix: "5" });

    const callbackRes = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=test-code-5&state=${session.state}`,
    });
    assert.equal(callbackRes.statusCode, 200);

    const denyRes = await app.inject({
      method: "POST",
      url: "/auth/github/callback/confirm",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ state: session.state, action: "deny" }),
    });

    assert.equal(denyRes.statusCode, 200);
    assert.match(denyRes.body, /Sign-in cancelled/);

    const updatedSession = pendingAuthStore.getSessionByTokenHash(session.tokenHash);
    assert.equal(updatedSession?.status, "denied");
  });

  it("keeps the legacy POST /auth/github/callback flow working", async () => {
    const initRes = await app.inject({
      method: "GET",
      url: "/auth/github?redirect_uri=myapp%3A%2F%2Foauth%2Fcallback&code_challenge=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    });
    assert.equal(initRes.statusCode, 200);

    const { state } = initRes.json<{ authUrl: string; state: string }>();
    const callbackRes = await app.inject({
      method: "POST",
      url: "/auth/github/callback",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        code: "legacy-code",
        codeVerifier: "legacy-verifier",
        state,
        redirectUri: "myapp://oauth/callback",
      }),
    });

    assert.equal(callbackRes.statusCode, 200);
    assert.deepEqual(callbackRes.json(), {
      accessToken: TEST_TOKENS.accessToken,
      refreshToken: TEST_TOKENS.refreshToken,
      user: {
        id: "github-user-123",
        provider: "github",
        providerUserId: TEST_IDENTITY.providerUserId,
        providerUsername: TEST_IDENTITY.providerUsername,
      },
    });
  });

  it("renders a Google confirmation page with the pending user code", async () => {
    const session = createPendingSession({ provider: OAuthProviderName.Google, tokenSuffix: "6" });

    const res = await app.inject({
      method: "GET",
      url: `/auth/google/callback?code=test-code-6&state=${session.state}`,
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /^text\/html/);
    assert.match(res.body, /Confirm Sesori sign-in/);
    assert.match(res.body, new RegExp(session.userCode));
    assert.match(res.body, /Confirm/);

    const updatedSession = pendingAuthStore.getSessionByTokenHash(session.tokenHash);
    assert.equal(updatedSession?.status, "awaiting_confirmation");
  });

  it("completes a Google pending session after explicit confirmation", async () => {
    const session = createPendingSession({ provider: OAuthProviderName.Google, tokenSuffix: "7" });

    const callbackRes = await app.inject({
      method: "GET",
      url: `/auth/google/callback?code=test-code-7&state=${session.state}`,
    });
    assert.equal(callbackRes.statusCode, 200);

    const confirmRes = await app.inject({
      method: "POST",
      url: "/auth/google/callback/confirm",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ state: session.state, action: "confirm" }),
    });

    assert.equal(confirmRes.statusCode, 200);
    assert.match(confirmRes.body, /Sign-in confirmed/);

    const statusRes = await app.inject({
      method: "GET",
      url: "/auth/session/status",
      headers: { "x-sesori-session-token": session.sessionToken },
    });

    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.json().status, "complete");
  });

  it("escapes provider-supplied error_description in the rendered HTML (QA-4)", async () => {
    const session = createPendingSession({ provider: OAuthProviderName.Github, tokenSuffix: "8" });
    const evilDescription = "<script>alert(1)</script>";

    const res = await app.inject({
      method: "GET",
      url: `/auth/github/callback?error=invalid_request&error_description=${encodeURIComponent(evilDescription)}&state=${session.state}`,
    });

    assert.equal(res.statusCode, 400);
    assert.ok(!res.body.includes("<script>alert(1)</script>"), "raw script tag must not appear in HTML");
    assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("rejects confirm after deny via the terminal-state guard (QA-8)", async () => {
    const session = createPendingSession({ provider: OAuthProviderName.Github, tokenSuffix: "9" });

    const callbackRes = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=test-code-9&state=${session.state}`,
    });
    assert.equal(callbackRes.statusCode, 200);

    const denyRes = await app.inject({
      method: "POST",
      url: "/auth/github/callback/confirm",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ state: session.state, action: "deny" }),
    });
    assert.equal(denyRes.statusCode, 200);
    assert.match(denyRes.body, /Sign-in cancelled/);

    const confirmRes = await app.inject({
      method: "POST",
      url: "/auth/github/callback/confirm",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ state: session.state, action: "confirm" }),
    });

    assert.match(confirmRes.body, /Sign-in cancelled|already cancelled/);
    const status = pendingAuthStore.getSessionByTokenHash(session.tokenHash);
    assert.equal(status?.status, "denied");
  });

  it("ignores query parameters on the confirm endpoint (CQ-3)", async () => {
    const session = createPendingSession({ provider: OAuthProviderName.Github, tokenSuffix: "a" });

    await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=test-a&state=${session.state}`,
    });

    // Body is empty; attacker tries to drive the action via query string only.
    // Body-only parser must reject (400 Invalid confirmation request).
    const res = await app.inject({
      method: "POST",
      url: `/auth/github/callback/confirm?state=${session.state}&action=confirm`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({}),
    });

    assert.equal(res.statusCode, 400);
    const status = pendingAuthStore.getSessionByTokenHash(session.tokenHash);
    assert.equal(status?.status, "awaiting_confirmation");
  });

  it("accepts form-encoded confirm submissions (AR-3 happy path)", async () => {
    const session = createPendingSession({ provider: OAuthProviderName.Github, tokenSuffix: "b" });

    await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=test-b&state=${session.state}`,
    });

    const confirmRes = await app.inject({
      method: "POST",
      url: "/auth/github/callback/confirm",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `state=${encodeURIComponent(session.state)}&action=confirm`,
    });

    assert.equal(confirmRes.statusCode, 200);
    assert.match(confirmRes.body, /Sign-in confirmed/);
  });

  it("form parser is scoped to confirm route only — sibling /auth/github/init rejects form bodies with 415 (AR-3 regression)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/github/init",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-sesori-session-token": VALID_SESSION_TOKEN,
      },
      payload: "clientType=bridge_macos",
    });

    assert.equal(res.statusCode, 415, "form-encoded body must NOT be accepted on /auth/github/init");
  });

  function createPendingSession(params: {
    provider: OAuthProviderName;
    store?: PendingAuthStore;
    tokenSuffix?: string;
  }) {
    const sessionToken = `${VALID_SESSION_TOKEN.slice(0, -1)}${params.tokenSuffix ?? "0"}`;
    const tokenHash = PendingAuthStore.hashToken(sessionToken);
    const store = params.store ?? pendingAuthStore;
    // Real 64-hex state (matches production format and the route's regex).
    const state = crypto.randomBytes(32).toString("hex");
    const session = store.createSession({
      tokenHash,
      provider: params.provider,
      pkceVerifier: `pkce-verifier-${params.tokenSuffix ?? "0"}`,
      state,
    });

    return {
      ...session,
      sessionToken,
    };
  }
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { Config } from "../../src/config.js";
import { StateStore } from "../../src/lib/state-store.js";
import { PendingAuthStore } from "../../src/services/pending-auth-store.js";
import { buildApp, type AppServices } from "../../src/server.js";
import { FakeOAuthClient } from "../helpers/fake-oauth-client.js";

const VALID_CODE_CHALLENGE = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const VALID_REDIRECT_URI = "myapp://oauth/callback";
const VALID_SESSION_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function createTestConfig(): Config {
  return {
    PORT: 3001,
    AUTH_BASE_URL: "https://api.sesori.com",
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

function createTestServices(pendingAuthStore: PendingAuthStore): AppServices {
  const fakeOAuthClient = new FakeOAuthClient({
    providerUserId: "provider-user-id",
    providerUsername: "provider-username",
    email: "provider@example.com",
  });

  return {
    config: createTestConfig(),
    authService: {} as AppServices["authService"],
    tokenService: {} as AppServices["tokenService"],
    voiceService: {} as AppServices["voiceService"],
    sessionMetadataService: {} as AppServices["sessionMetadataService"],
    installScriptService: {} as AppServices["installScriptService"],
    legalDocumentService: {} as AppServices["legalDocumentService"],
    deviceTokenRepo: {} as AppServices["deviceTokenRepo"],
    notificationService: {} as AppServices["notificationService"],
    bridgeStateTracker: {} as AppServices["bridgeStateTracker"],
    stateStore: new StateStore(),
    pendingAuthStore,
    githubClient: fakeOAuthClient as unknown as AppServices["githubClient"],
    googleClient: fakeOAuthClient as unknown as AppServices["googleClient"],
    appleClient: fakeOAuthClient as unknown as AppServices["appleClient"],
    appleNativeVerifier: {} as AppServices["appleNativeVerifier"],
  };
}

describe("OAuth init routes", () => {
  let app: FastifyInstance;
  let pendingAuthStore: PendingAuthStore;

  before(async () => {
    pendingAuthStore = new PendingAuthStore();
    app = await buildApp(createTestServices(pendingAuthStore));
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("keeps the legacy GET /auth/github endpoint working", async () => {
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

  it("creates a pending GitHub auth session with backend callback redirect", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/github/init",
      headers: {
        "content-type": "application/json",
        "x-sesori-session-token": VALID_SESSION_TOKEN,
      },
      payload: JSON.stringify({ clientType: "bridge-macos" }),
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{ authUrl: string; state: string; userCode: string; expiresIn: number }>();
    assert.equal(body.expiresIn, 300);
    assert.match(body.state, /^[a-f0-9]{64}$/);
    assert.match(body.userCode, /^[A-Z2-9]{4}$/);

    const authUrl = new URL(body.authUrl);
    assert.equal(authUrl.origin, "https://github.com");
    assert.equal(authUrl.pathname, "/login/oauth/authorize");
    assert.equal(authUrl.searchParams.get("redirect_uri"), "https://api.sesori.com/auth/github/callback");
    assert.equal(authUrl.searchParams.get("state"), body.state);
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authUrl.searchParams.get("code_challenge"));
    assert.ok(!body.authUrl.includes(VALID_SESSION_TOKEN));

    const session = pendingAuthStore.getSession(PendingAuthStore.hashToken(VALID_SESSION_TOKEN));
    assert.ok(session);
    assert.equal(session?.state, body.state);
    assert.equal(session?.userCode, body.userCode);
    assert.equal(session?.provider, "github");
    assert.ok(session?.pkceVerifier);
  });

  it("creates a pending Google auth session with backend callback redirect", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/google/init",
      headers: {
        "content-type": "application/json",
        "x-sesori-session-token": VALID_SESSION_TOKEN,
      },
      payload: JSON.stringify({ clientType: "app_android" }),
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{ authUrl: string; state: string; userCode: string; expiresIn: number }>();
    assert.equal(body.expiresIn, 300);

    const authUrl = new URL(body.authUrl);
    assert.equal(authUrl.origin, "https://accounts.google.com");
    assert.equal(authUrl.pathname, "/o/oauth2/v2/auth");
    assert.equal(authUrl.searchParams.get("redirect_uri"), "https://api.sesori.com/auth/google/callback");
    assert.equal(authUrl.searchParams.get("response_type"), "code");
    assert.equal(authUrl.searchParams.get("prompt"), "consent");
    assert.equal(authUrl.searchParams.get("state"), body.state);
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authUrl.searchParams.get("code_challenge"));

    const session = pendingAuthStore.getSession(PendingAuthStore.hashToken(VALID_SESSION_TOKEN));
    assert.ok(session);
    assert.equal(session?.state, body.state);
    assert.equal(session?.userCode, body.userCode);
    assert.equal(session?.provider, "google");
    assert.ok(session?.pkceVerifier);
  });

  it("rejects missing session-token header for init", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/github/init",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ clientType: "bridge" }),
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json<{ error: string }>().error, "bad_request");
  });

  it("rejects unknown clientType for init", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/google/init",
      headers: {
        "content-type": "application/json",
        "x-sesori-session-token": VALID_SESSION_TOKEN,
      },
      payload: JSON.stringify({ clientType: "desktop" }),
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json<{ error: string }>().error, "bad_request");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configSchemaForTest, loadGlossaryMigrationConfig, loadSonioxPurgeConfig } from "../src/config.js";
import { SONIOX_REST_URL_BY_REGION } from "../src/types/transcription.js";

describe("loadGlossaryMigrationConfig", () => {
  it("returns only the validated MongoDB URI", () => {
    assert.deepEqual(
      loadGlossaryMigrationConfig({
        MONGODB_URI: "mongodb://localhost:27017/oauth",
        JWT_PRIVATE_KEY: "must-not-cross-the-cli-boundary",
      }),
      { mongodbUri: "mongodb://localhost:27017/oauth" },
    );
  });

  it("rejects missing and empty MongoDB URIs without loading web config", () => {
    assert.throws(() => loadGlossaryMigrationConfig({}), /GlossaryMigrationConfigError/);
    assert.throws(() => loadGlossaryMigrationConfig({ MONGODB_URI: "" }), /GlossaryMigrationConfigError/);
    assert.throws(
      () => loadGlossaryMigrationConfig({ MONGODB_URI: "not-a-mongodb-uri" }),
      /GlossaryMigrationConfigError/,
    );
  });
});

describe("loadSonioxPurgeConfig", () => {
  it("returns only the Soniox credentials the operator script needs", () => {
    assert.deepEqual(
      loadSonioxPurgeConfig({
        SONIOX_API_KEY: "test-soniox-key",
        MONGODB_URI: "mongodb://localhost:27017/oauth",
        JWT_PRIVATE_KEY: "must-not-cross-the-cli-boundary",
      }),
      { apiKey: "test-soniox-key", region: "eu" },
    );
  });

  it("rejects a missing or empty key and a non-EU region", () => {
    assert.throws(() => loadSonioxPurgeConfig({}), /SonioxPurgeConfigError/);
    assert.throws(() => loadSonioxPurgeConfig({ SONIOX_API_KEY: "" }), /SonioxPurgeConfigError/);
    assert.throws(() => loadSonioxPurgeConfig({ SONIOX_API_KEY: "k", SONIOX_REGION: "us" }), /SonioxPurgeConfigError/);
  });
});

describe("async transcription provider configuration", () => {
  const base = {
    MONGODB_URI: "mongodb://localhost:27017/oauth",
    JWT_PRIVATE_KEY: "key",
    JWT_PUBLIC_KEY: "key",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    APPLE_CLIENT_ID: "id",
    APPLE_IOS_CLIENT_ID: "id",
    APPLE_TEAM_ID: "team",
    APPLE_KEY_ID: "key",
    APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
    ALLOWED_REDIRECT_URIS: "myapp://oauth/callback",
    RELAY_URL: "ws://localhost:8080",
    RELAY_WEBHOOK_SECRET: "secret",
    OPENAI_API_KEY: "key",
    PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
    FCM_SA_JSON: Buffer.from(
      JSON.stringify({
        type: "service_account",
        project_id: "p",
        private_key_id: "k",
        private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
        client_email: "a@b.iam.gserviceaccount.com",
        client_id: "1",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/a",
        universe_domain: "googleapis.com",
      }),
    ).toString("base64"),
  };

  it("defaults to OpenAI and does not require a Soniox key", () => {
    const result = configSchemaForTest.safeParse(base);
    assert.equal(result.success, true);
    assert.equal(result.data?.ASYNC_TRANSCRIPTION_PROVIDER, "openai");
  });

  it("requires the Soniox key only when Soniox is selected", () => {
    const missing = configSchemaForTest.safeParse({ ...base, ASYNC_TRANSCRIPTION_PROVIDER: "soniox" });
    assert.equal(missing.success, false);

    const provided = configSchemaForTest.safeParse({
      ...base,
      ASYNC_TRANSCRIPTION_PROVIDER: "soniox",
      SONIOX_API_KEY: "soniox-key",
    });
    assert.equal(provided.success, true);
    assert.equal(provided.data?.SONIOX_REGION, "eu");
    assert.equal(provided.data?.SONIOX_ASYNC_MODEL, "stt-async-v5");
  });

  it("rejects an unknown provider, a non-EU region, and out-of-range timeouts", () => {
    assert.equal(configSchemaForTest.safeParse({ ...base, ASYNC_TRANSCRIPTION_PROVIDER: "whisper" }).success, false);
    assert.equal(configSchemaForTest.safeParse({ ...base, SONIOX_REGION: "us" }).success, false);
    assert.equal(configSchemaForTest.safeParse({ ...base, SONIOX_ASYNC_TIMEOUT_MS: "999" }).success, false);
    assert.equal(configSchemaForTest.safeParse({ ...base, SONIOX_ASYNC_TIMEOUT_MS: "120000" }).success, false);
    assert.equal(configSchemaForTest.safeParse({ ...base, SONIOX_CLEANUP_TIMEOUT_MS: "40000" }).success, false);
  });
});

describe("Soniox endpoint pinning", () => {
  it("resolves the EU region to the explicit EU REST URL", () => {
    assert.equal(SONIOX_REST_URL_BY_REGION.eu, "https://api.eu.soniox.com");
  });

  it("outranks SDK environment endpoint overrides", async () => {
    // region alone resolves BELOW SONIOX_BASE_DOMAIN/SONIOX_API_BASE_URL in the
    // SDK, so an env var could otherwise send audio and the key to another host.
    const previous = process.env.SONIOX_API_BASE_URL;
    process.env.SONIOX_API_BASE_URL = "https://redirected.example.com";
    try {
      const { SonioxNodeClient } = await import("@soniox/node");
      const unpinned = new SonioxNodeClient({ api_key: "k", region: "eu" });
      const pinned = new SonioxNodeClient({
        api_key: "k",
        region: "eu",
        base_url: SONIOX_REST_URL_BY_REGION.eu,
      });

      const readBaseUrl = (client: unknown): unknown =>
        (client as { files: { http: { baseUrl?: unknown } } }).files.http.baseUrl;

      assert.equal(readBaseUrl(unpinned), "https://redirected.example.com");
      assert.equal(readBaseUrl(pinned), "https://api.eu.soniox.com");
    } finally {
      if (previous === undefined) {
        delete process.env.SONIOX_API_BASE_URL;
      } else {
        process.env.SONIOX_API_BASE_URL = previous;
      }
    }
  });
});

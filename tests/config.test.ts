import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configSchema, loadGlossaryMigrationConfig } from "../src/config.js";

const serviceAccount = {
  type: "service_account",
  project_id: "sesori-test",
  private_key_id: "key-id",
  private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
  client_email: "test@sesori-test.iam.gserviceaccount.com",
  client_id: "1234567890",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/test",
  universe_domain: "googleapis.com",
};

function validEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MONGODB_URI: "mongodb://localhost:27017/test",
    JWT_PRIVATE_KEY: "private",
    JWT_PUBLIC_KEY: "public",
    GITHUB_CLIENT_ID: "gh-id",
    GITHUB_CLIENT_SECRET: "gh-secret",
    GOOGLE_CLIENT_ID: "goog-id",
    GOOGLE_CLIENT_SECRET: "goog-secret",
    APPLE_CLIENT_ID: "apple-id",
    APPLE_IOS_CLIENT_ID: "apple-ios-id",
    APPLE_TEAM_ID: "apple-team",
    APPLE_KEY_ID: "apple-key",
    APPLE_PRIVATE_KEY: "apple-private",
    ALLOWED_REDIRECT_URIS: "https://api.sesori.com/callback",
    RELAY_URL: "wss://relay.sesori.com",
    PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY: Buffer.alloc(32, 7).toString("base64"),
    OPENAI_API_KEY: "openai-key",
    FCM_SA_JSON: Buffer.from(JSON.stringify(serviceAccount), "utf8").toString("base64"),
    ...overrides,
  };
}

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

describe("configSchema", () => {
  it("accepts the baseline environment", () => {
    assert.equal(configSchema.safeParse(validEnv()).success, true);
  });

  it("disables the dev auth bypass and proxy trust by default", () => {
    const result = configSchema.safeParse(validEnv());

    assert.equal(result.success, true);
    assert.equal(result.data?.AUTH_DEV_BYPASS_ENABLED, false);
    assert.equal(result.data?.TRUST_PROXY, false);
  });

  it("enables proxy trust only when explicitly requested", () => {
    for (const [value, expected] of [
      ["true", true],
      ["1", true],
      ["false", false],
      ["0", false],
    ] as const) {
      const result = configSchema.safeParse(validEnv({ TRUST_PROXY: value }));

      assert.equal(result.success, true, `TRUST_PROXY=${value} should parse`);
      assert.equal(result.data?.TRUST_PROXY, expected);
    }
  });

  it("refuses to start when the dev auth bypass is enabled in production", () => {
    const result = configSchema.safeParse(validEnv({ AUTH_DEV_BYPASS_ENABLED: "true", NODE_ENV: "production" }));

    assert.equal(result.success, false);
    assert.ok(result.error?.issues.some((issue) => issue.path.includes("AUTH_DEV_BYPASS_ENABLED")));
  });

  it("refuses to start when the dev auth bypass is enabled without an explicit development env", () => {
    const result = configSchema.safeParse(validEnv({ AUTH_DEV_BYPASS_ENABLED: "true" }));

    assert.equal(result.success, false);
    assert.ok(result.error?.issues.some((issue) => issue.path.includes("AUTH_DEV_BYPASS_ENABLED")));
  });

  it("allows the dev auth bypass under an explicit development env", () => {
    const result = configSchema.safeParse(validEnv({ AUTH_DEV_BYPASS_ENABLED: "true", NODE_ENV: "development" }));

    assert.equal(result.success, true);
    assert.equal(result.data?.AUTH_DEV_BYPASS_ENABLED, true);
  });
});

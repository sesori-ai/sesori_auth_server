import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  configSchema,
  configSchemaForTest,
  loadGlossaryMigrationConfig,
  loadSonioxPurgeConfig,
} from "../src/config.js";
import { createSonioxRealtimeSdkOptions } from "../src/clients/soniox-realtime-sdk-factory.js";
import { ClientIpSource } from "../src/types/client-ip.js";
import { SONIOX_REALTIME_WS_URL_BY_REGION, SONIOX_REST_URL_BY_REGION } from "../src/types/transcription.js";

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

  it("ignores hostile realtime websocket endpoint environment in parsed config", () => {
    const result = configSchemaForTest.safeParse({
      ...base,
      REALTIME_TRANSCRIPTION_ENABLED: "true",
      SONIOX_API_KEY: "soniox-key",
      SONIOX_WS_URL: "wss://attacker.example.com/transcribe",
    });

    assert.equal(result.success, true);
    if (!result.success) {
      throw new Error("expected config parse success");
    }

    assert.equal("SONIOX_WS_URL" in result.data, false);
    const sonioxApiKey = result.data.SONIOX_API_KEY;
    if (sonioxApiKey === undefined) {
      throw new Error("expected Soniox API key in parsed config");
    }

    assert.deepEqual(
      createSonioxRealtimeSdkOptions({
        apiKey: sonioxApiKey,
        region: result.data.SONIOX_REGION,
      }).realtime,
      { ws_base_url: SONIOX_REALTIME_WS_URL_BY_REGION.eu },
    );
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

describe("configSchema", () => {
  it("accepts the baseline environment", () => {
    assert.equal(configSchema.safeParse(validEnv()).success, true);
  });

  it("disables the dev auth bypass by default", () => {
    const result = configSchema.safeParse(validEnv());

    assert.equal(result.success, true);
    assert.equal(result.data?.AUTH_DEV_BYPASS_ENABLED, false);
  });

  it("uses socket client IP resolution by default", () => {
    const result = configSchema.safeParse(validEnv());

    assert.equal(result.success, true);
    assert.equal(result.data?.CLIENT_IP_SOURCE, ClientIpSource.Socket);
  });

  it("accepts Cloudflare client IP resolution with configured ingress CIDRs", () => {
    const result = configSchema.safeParse(
      validEnv({ CLIENT_IP_SOURCE: "cloudflare", CLOUDFLARE_INGRESS_CIDRS: "173.245.48.0/20, 2400:cb00::/32" }),
    );

    assert.equal(result.success, true);
    assert.equal(result.data?.CLIENT_IP_SOURCE, ClientIpSource.Cloudflare);
    assert.deepEqual(result.data?.CLOUDFLARE_INGRESS_CIDRS, ["173.245.48.0/20", "2400:cb00::/32"]);
  });

  it("rejects unknown client IP source values", () => {
    const result = configSchema.safeParse(validEnv({ CLIENT_IP_SOURCE: "trust_proxy" }));

    assert.equal(result.success, false);
    assert.ok(result.error?.issues.some((issue) => issue.path.includes("CLIENT_IP_SOURCE")));
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

  // NODE_ENV is deliberately an unconstrained string so deployments using values
  // like "staging" still boot; the gate must therefore match nothing but an
  // exact "development", including case and whitespace variants.
  it("refuses to start on development-like values that are not exactly development", () => {
    for (const nodeEnv of ["Development", "DEVELOPMENT", " development", "development ", "dev"]) {
      const result = configSchema.safeParse(validEnv({ AUTH_DEV_BYPASS_ENABLED: "true", NODE_ENV: nodeEnv }));

      assert.equal(result.success, false, `NODE_ENV=${JSON.stringify(nodeEnv)} must not enable the bypass`);
    }
  });

  it("rejects dev bypass values that are not an exact boolean literal", () => {
    for (const value of ["TRUE", "True", "yes", "", " true", "2"]) {
      const result = configSchema.safeParse(validEnv({ AUTH_DEV_BYPASS_ENABLED: value, NODE_ENV: "development" }));

      assert.equal(result.success, false, `AUTH_DEV_BYPASS_ENABLED=${JSON.stringify(value)} should be rejected`);
    }
  });

  it("parses a Cloudflare ingress list into trimmed entries", () => {
    const result = configSchema.safeParse(
      validEnv({ CLOUDFLARE_INGRESS_CIDRS: " 198.51.100.0/24 , 2001:db8::/32 ,203.0.113.7 " }),
    );

    assert.equal(result.success, true);
    assert.deepEqual(result.data?.CLOUDFLARE_INGRESS_CIDRS, ["198.51.100.0/24", "2001:db8::/32", "203.0.113.7"]);
  });

  it("treats an absent or empty Cloudflare ingress list as unset", () => {
    assert.equal(configSchema.safeParse(validEnv()).data?.CLOUDFLARE_INGRESS_CIDRS, undefined);
    assert.equal(
      configSchema.safeParse(validEnv({ CLOUDFLARE_INGRESS_CIDRS: " , " })).data?.CLOUDFLARE_INGRESS_CIDRS,
      undefined,
    );
  });

  // A malformed entry would otherwise reach @fastify/proxy-addr, which compiles
  // the list when the app boots and throws an opaque ipaddr.js range error.
  it("rejects a Cloudflare ingress list containing anything that is not an IP or CIDR", () => {
    for (const value of [
      "not-an-ip",
      "198.51.100.0/",
      "198.51.100.0/33",
      "2001:db8::/129",
      "198.51.100.0/8/8",
      "198.51.100.0/0x8",
      "198.51.100.0/+8",
      "198.51.100.0/-1",
      "198.51.100.0/ 8",
      "198.51.100.0/08",
      "198.51.100.0,not-an-ip",
      // @fastify/proxy-addr rejects range <= 0, so a zero prefix must not pass
      // config validation and reach proxyaddr.compile at boot.
      "0.0.0.0/0",
      "::/0",
    ]) {
      const result = configSchema.safeParse(validEnv({ CLOUDFLARE_INGRESS_CIDRS: value }));

      assert.equal(result.success, false, `CLOUDFLARE_INGRESS_CIDRS=${JSON.stringify(value)} should be rejected`);
    }
  });

  it("allows the dev auth bypass under an explicit development env", () => {
    const result = configSchema.safeParse(validEnv({ AUTH_DEV_BYPASS_ENABLED: "true", NODE_ENV: "development" }));

    assert.equal(result.success, true);
    assert.equal(result.data?.AUTH_DEV_BYPASS_ENABLED, true);
  });
});

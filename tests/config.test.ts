import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configSchema, loadGlossaryMigrationConfig } from "../src/config.js";
import { ClientIpSource } from "../src/types/client-ip.js";

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

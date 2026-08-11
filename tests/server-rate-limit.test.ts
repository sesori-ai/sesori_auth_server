import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import type { InjectPayload, Response as LightMyRequestResponse } from "light-my-request";
import { createTestApp } from "./helpers/setup.js";
import { ClientIpSource } from "../src/types/client-ip.js";

const RATE_LIMIT_MAX = 100;

type InjectOptions = {
  readonly method?: "GET" | "POST";
  readonly url: string;
  readonly remoteAddress: string;
  readonly headers?: Record<string, string>;
  readonly payload?: InjectPayload;
};

async function injectFrom(app: FastifyInstance, options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject({
    method: options.method ?? "GET",
    url: options.url,
    remoteAddress: options.remoteAddress,
    headers: options.headers,
    payload: options.payload,
  });
}

describe("buildApp rate limit client IP wiring", () => {
  describe("cloudflare mode", () => {
    let app: FastifyInstance;
    let cleanup: () => Promise<void>;

    before(async () => {
      const ctx = await createTestApp({
        configOverrides: {
          CLIENT_IP_SOURCE: ClientIpSource.Cloudflare,
          CLOUDFLARE_INGRESS_CIDRS: ["198.51.100.0/24"],
        },
      });
      app = ctx.app;
      cleanup = ctx.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it("keeps distinct clients behind the proxy in independent buckets", async () => {
      for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
        const res = await injectFrom(app, {
          url: "/auth/public-key",
          remoteAddress: "198.51.100.10",
          headers: { "cf-connecting-ip": "203.0.113.10" },
        });
        assert.equal(res.statusCode, 200);
      }

      const otherClient = await injectFrom(app, {
        url: "/auth/public-key",
        remoteAddress: "198.51.100.10",
        headers: { "cf-connecting-ip": "203.0.113.20" },
      });
      assert.equal(otherClient.statusCode, 200);

      const originalClient = await injectFrom(app, {
        url: "/auth/public-key",
        remoteAddress: "198.51.100.10",
        headers: { "cf-connecting-ip": "203.0.113.10" },
      });
      assert.equal(originalClient.statusCode, 429);
    });
  });

  describe("cloudflare mode with forged non-Cloudflare headers", () => {
    let app: FastifyInstance;
    let cleanup: () => Promise<void>;

    before(async () => {
      const ctx = await createTestApp({
        configOverrides: {
          CLIENT_IP_SOURCE: ClientIpSource.Cloudflare,
          CLOUDFLARE_INGRESS_CIDRS: ["198.51.100.0/24"],
        },
      });
      app = ctx.app;
      cleanup = ctx.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it("does not let one client mint fresh buckets by varying a forged header", async () => {
      for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
        const res = await injectFrom(app, {
          url: "/auth/public-key",
          remoteAddress: "198.51.100.11",
          headers: {
            "cf-connecting-ip": "203.0.113.30",
            "x-forwarded-for": `192.0.2.${i}`,
          },
        });
        assert.equal(res.statusCode, 200);
      }

      const res = await injectFrom(app, {
        url: "/auth/public-key",
        remoteAddress: "198.51.100.11",
        headers: {
          "cf-connecting-ip": "203.0.113.30",
          "x-forwarded-for": "192.0.2.250",
        },
      });
      assert.equal(res.statusCode, 429);
    });
  });

  describe("socket mode", () => {
    let app: FastifyInstance;
    let cleanup: () => Promise<void>;

    before(async () => {
      const ctx = await createTestApp({ configOverrides: { CLIENT_IP_SOURCE: ClientIpSource.Socket } });
      app = ctx.app;
      cleanup = ctx.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it("ignores CF-Connecting-IP entirely", async () => {
      for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
        const res = await injectFrom(app, {
          url: "/auth/public-key",
          remoteAddress: "198.51.100.12",
          headers: { "cf-connecting-ip": `203.0.113.${i}` },
        });
        assert.equal(res.statusCode, 200);
      }

      const res = await injectFrom(app, {
        url: "/auth/public-key",
        remoteAddress: "198.51.100.12",
        headers: { "cf-connecting-ip": "203.0.113.250" },
      });
      assert.equal(res.statusCode, 429);
    });
  });

  // Without CLOUDFLARE_INGRESS_CIDRS the header is honoured on any connection,
  // which is the documented at-your-own-risk configuration. Even there, a forged
  // header must never buy a *total* exemption: @fastify/rate-limit matches an
  // array allowList against the generated key, so loopback literals in that list
  // would make `CF-Connecting-IP: 127.0.0.1` skip the limiter outright.
  describe("cloudflare mode without an ingress allowlist", () => {
    let app: FastifyInstance;
    let cleanup: () => Promise<void>;

    before(async () => {
      const ctx = await createTestApp({
        configOverrides: { CLIENT_IP_SOURCE: ClientIpSource.Cloudflare, CLOUDFLARE_INGRESS_CIDRS: undefined },
      });
      app = ctx.app;
      cleanup = ctx.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it("does not let a forged loopback CF-Connecting-IP skip the limiter", async () => {
      let throttled = false;

      for (let i = 0; i <= RATE_LIMIT_MAX; i += 1) {
        const res = await injectFrom(app, {
          url: "/auth/public-key",
          remoteAddress: "203.0.113.99",
          headers: { "cf-connecting-ip": "127.0.0.1" },
        });

        if (res.statusCode === 429) {
          throttled = true;
          break;
        }
      }

      assert.ok(throttled, "a forged loopback CF-Connecting-IP must not be exempt from rate limiting");
    });

    it("still exempts a genuine loopback connection", async () => {
      for (let i = 0; i <= RATE_LIMIT_MAX; i += 1) {
        const res = await injectFrom(app, { url: "/auth/public-key", remoteAddress: "127.0.0.1" });
        assert.equal(res.statusCode, 200);
      }
    });
  });

  describe("global limiter exemptions", () => {
    let app: FastifyInstance;
    let cleanup: () => Promise<void>;

    before(async () => {
      const ctx = await createTestApp({ configOverrides: { CLIENT_IP_SOURCE: ClientIpSource.Socket } });
      app = ctx.app;
      cleanup = ctx.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it("never rate limits /health", async () => {
      for (let i = 0; i <= RATE_LIMIT_MAX; i += 1) {
        const res = await injectFrom(app, { url: "/health", remoteAddress: "198.51.100.13" });
        assert.equal(res.statusCode, 200);
      }
    });

    it("never rate limits /internal/bridge-status", async () => {
      for (let i = 0; i <= RATE_LIMIT_MAX; i += 1) {
        const res = await injectFrom(app, {
          method: "POST",
          url: "/internal/bridge-status",
          remoteAddress: "198.51.100.14",
          headers: { "x-relay-secret": "test-relay-secret" },
          payload: {
            userId: "user-1",
            bridgeId: "br_unknown",
            status: "connected",
            timestamp: new Date().toISOString(),
          },
        });
        assert.equal(res.statusCode, 400);
      }
    });
  });
});

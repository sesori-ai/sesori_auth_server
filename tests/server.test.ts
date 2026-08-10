import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/setup.js";

// The middleware unit tests prove the bypass flag behaves correctly in
// isolation. This suite proves buildApp actually hands the config flag to
// createAuthMiddleware: without it, reverting server.ts to the single-argument
// call would leave every unit test green while the flag silently did nothing.
describe("buildApp auth bypass wiring", () => {
  describe("with the default configuration", () => {
    let app: FastifyInstance;
    let cleanup: () => Promise<void>;

    before(async () => {
      const ctx = await createTestApp();
      app = ctx.app;
      cleanup = ctx.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it("rejects an unauthenticated request to a protected route", async () => {
      const res = await app.inject({ method: "GET", url: "/auth/me" });

      assert.equal(res.statusCode, 401);
    });

    it("still rejects when the caller supplies a development-looking environment header", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { "x-node-env": "development" },
      });

      assert.equal(res.statusCode, 401);
    });
  });

  describe("with AUTH_DEV_BYPASS_ENABLED turned on", () => {
    let app: FastifyInstance;
    let cleanup: () => Promise<void>;

    before(async () => {
      const ctx = await createTestApp({ configOverrides: { AUTH_DEV_BYPASS_ENABLED: true } });
      app = ctx.app;
      cleanup = ctx.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it("lets an unauthenticated request past the auth layer", async () => {
      const res = await app.inject({ method: "GET", url: "/auth/me" });

      assert.notEqual(res.statusCode, 401);
    });
  });
});

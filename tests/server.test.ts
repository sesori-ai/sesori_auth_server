import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { createTestApp, type TestContext } from "./helpers/setup.js";

// A refused request is normal operation. It used to go to stderr with the
// cause's full stack, which read as a server fault in the runtime logs.
describe("error handler logging of refused requests", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("logs an expired refresh token as one plain stdout line without a stack", async () => {
    const user = await ctx.createUser();
    const refreshToken = ctx.createExpiredRefreshToken(user.userId);
    const { exp } = jwt.decode(refreshToken) as { exp: number };
    const infoLog = mock.method(console, "info", () => {});
    const errorLog = mock.method(console, "error", () => {});

    try {
      const res = await ctx.app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });

      assert.equal(res.statusCode, 401);
      assert.equal(errorLog.mock.callCount(), 0);
      assert.deepEqual(
        infoLog.mock.calls.map((call) => call.arguments),
        [[`Rejected POST /auth/refresh with 401: Refresh token expired at ${new Date(exp * 1000).toISOString()}`]],
      );
    } finally {
      infoLog.mock.restore();
      errorLog.mock.restore();
    }
  });

  it("keeps the short message of any other verification failure", async () => {
    const infoLog = mock.method(console, "info", () => {});

    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        payload: { refreshToken: "not-a-jwt" },
      });

      assert.equal(res.statusCode, 401);
      assert.deepEqual(
        infoLog.mock.calls.map((call) => call.arguments),
        [["Rejected POST /auth/refresh with 401: Refresh token verification failed (jwt malformed)"]],
      );
    } finally {
      infoLog.mock.restore();
    }
  });

  it("names the route template, not the requested URL, and keeps validation detail on the line", async () => {
    const infoLog = mock.method(console, "info", () => {});

    try {
      const res = await ctx.app.inject({ method: "POST", url: "/auth/refresh?secret-query=1", payload: {} });

      assert.equal(res.statusCode, 400);
      const logged = infoLog.mock.calls.map((call) => call.arguments);
      assert.equal(logged.length, 1);
      const [line] = logged[0];
      assert.equal(typeof line, "string");
      assert.ok(
        String(line).startsWith("Rejected POST /auth/refresh with 400: Invalid request body ([{"),
        String(line),
      );
      assert.equal(String(line).includes("secret-query"), false);
      assert.equal(String(line).includes("\n"), false);
    } finally {
      infoLog.mock.restore();
    }
  });
});

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
      // NODE_ENV is set alongside the flag because configSchema refuses to
      // produce this combination otherwise. buildApp never reads NODE_ENV, so
      // this only keeps the fixture to a state real startup validation permits.
      const ctx = await createTestApp({
        configOverrides: { AUTH_DEV_BYPASS_ENABLED: true, NODE_ENV: "development" },
      });
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

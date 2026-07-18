import assert from "node:assert/strict";
import http from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { ApiError } from "../../src/lib/errors.js";
import { appClientRoutes } from "../../src/routes/app-clients.js";
import {
  AppClientPresenceInitialReadTimeout,
  type AppClientPresenceService,
} from "../../src/services/app-client-presence-service.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("GET /auth/app-clients/status", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("returns immediate false and then true after an existing token registration", async () => {
    const user = await ctx.createUser();

    const absent = await ctx.app.inject({
      method: "GET",
      url: "/auth/app-clients/status",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const registration = await ctx.app.inject({
      method: "POST",
      url: "/notifications/register-token",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ token: `presence-${user.userId}`, platform: "macos" }),
    });
    const present = await ctx.app.inject({
      method: "GET",
      url: "/auth/app-clients/status",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    assert.equal(absent.statusCode, 200);
    assert.deepEqual(absent.json(), { registered: false });
    assert.equal(registration.statusCode, 200);
    assert.deepEqual(registration.json(), { ok: true });
    assert.equal(present.statusCode, 200);
    assert.deepEqual(present.json(), { registered: true });
  });

  it("wakes a long poll after the same user durably registers a token", async () => {
    const user = await ctx.createUser();
    const waiting = keepProcessAlive(
      ctx.app.inject({
        method: "GET",
        url: "/auth/app-clients/status?wait=true",
        headers: { authorization: `Bearer ${user.accessToken}` },
      }),
    );
    await delay(10);

    const registration = await ctx.app.inject({
      method: "POST",
      url: "/notifications/register-token",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ token: `wake-${user.userId}`, platform: "android" }),
    });
    const response = await waiting;

    assert.equal(registration.statusCode, 200);
    assert.deepEqual(registration.json(), { ok: true });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { registered: true });
  });

  it("requires auth and rejects unsupported or unknown query values", async () => {
    const user = await ctx.createUser();
    const missingAuth = await ctx.app.inject({ method: "GET", url: "/auth/app-clients/status" });
    const falseWait = await ctx.app.inject({
      method: "GET",
      url: "/auth/app-clients/status?wait=false",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const unknown = await ctx.app.inject({
      method: "GET",
      url: "/auth/app-clients/status?other=true",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    assert.equal(missingAuth.statusCode, 401);
    assert.deepEqual(missingAuth.json(), { error: "unauthenticated" });
    assert.equal(falseWait.statusCode, 400);
    assert.deepEqual(falseWait.json(), { error: "bad_request" });
    assert.equal(unknown.statusCode, 400);
    assert.deepEqual(unknown.json(), { error: "bad_request" });
  });
});

describe("app-client status route failure and disconnect mapping", () => {
  let apps: FastifyInstance[];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  before(() => {
    apps = [];
  });

  it("maps only the typed initial-read deadline to the existing 500 response", async () => {
    const app = await buildRouteApp({
      hasRegisteredClient: async () => false,
      waitForRegistration: async () => {
        throw new AppClientPresenceInitialReadTimeout();
      },
    });

    const response = await app.inject({ method: "GET", url: "/auth/app-clients/status?wait=true" });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: "internal_server_error" });
  });

  it("rejects an invalid service reply through the strict reply schema", async () => {
    const app = await buildRouteApp({
      hasRegisteredClient: async () => "not-a-boolean",
      waitForRegistration: async () => false,
    });

    const response = await app.inject({ method: "GET", url: "/auth/app-clients/status" });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: "internal_server_error" });
  });

  it("aborts the service wait and sends no late payload after client disconnect", async () => {
    let receivedSignal: AbortSignal | undefined;
    const app = await buildRouteApp({
      hasRegisteredClient: async () => false,
      waitForRegistration: async (params: { abortSignal: AbortSignal }) => {
        receivedSignal = params.abortSignal;
        if (params.abortSignal.aborted) {
          return null;
        }
        return new Promise<null>((resolve) => {
          params.abortSignal.addEventListener("abort", () => resolve(null), { once: true });
        });
      },
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const pending = openRequest(new URL("/auth/app-clients/status?wait=true", origin));
    await waitFor(() => receivedSignal !== undefined);

    pending.destroy();
    await pending.closed;
    await waitFor(() => receivedSignal?.aborted === true);

    assert.equal(receivedSignal?.aborted, true);
  });

  async function buildRouteApp(service: object): Promise<FastifyInstance> {
    const app = Fastify({ disableRequestLogging: true });
    apps.push(app);
    app.decorateRequest("user", null);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply.status(error.errorCode).send({ error: error.message });
      }
      return reply.status(500).send({ error: "internal_server_error" });
    });
    await app.register(appClientRoutes, {
      appClientPresenceService: service as AppClientPresenceService,
      requireAuth: async (request) => {
        request.user = {
          tokenType: "access",
          userId: "507f1f77bcf86cd799439011",
          provider: "github",
          providerUserId: "provider-user",
          iss: "auth-backend",
          aud: "mobile",
          iat: 1,
          exp: 2,
        };
      },
    });
    await app.ready();
    return app;
  }
});

function openRequest(url: URL): { destroy: () => void; closed: Promise<void> } {
  const request = http.request(url);
  const closed = new Promise<void>((resolve) => {
    request.once("close", resolve);
    request.once("error", () => resolve());
  });
  request.end();
  return { destroy: () => request.destroy(), closed };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not reached before deadline");
    }
    await delay(1);
  }
}

async function keepProcessAlive<T>(promise: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

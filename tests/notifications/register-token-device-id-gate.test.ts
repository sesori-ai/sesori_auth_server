import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Config } from "../../src/config.js";
import { ApiError } from "../../src/lib/errors.js";
import type { AccessTokenPayload } from "../../src/models/jwt.js";
import { DevicePlatform } from "../../src/models/device.js";
import { notificationRoutes, type NotificationRouteOptions } from "../../src/routes/notifications.js";

const USER_ID = "69b2aeaa1755fd6c00000001";
const DEVICE_ID = "550e8400-e29b-41d4-a716-446655440000";

type Registration = { userId: string; token: string; deviceId?: string };

// createTestApp resolves config through loadConfig(), which caches a
// process-wide singleton, so the flag cannot be varied per app there. Mounting
// the plugin directly is the only way to exercise both sides of the gate.
async function buildApp(required: boolean): Promise<{ app: FastifyInstance; registrations: Registration[] }> {
  const registrations: Registration[] = [];
  const app = Fastify();

  app.decorateRequest("user", null);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.errorCode).send({ error: error.message });
    }

    throw error;
  });

  const options = {
    config: { AUTH_REQUIRE_DEVICE_ID_IN_TOKEN_REGISTRATION: required } as Config,
    appClientPresenceService: {
      registerToken: async (params: Registration) => {
        registrations.push(params);
      },
    },
    activationService: { recordAppSetup: async () => {} },
    requireAuth: async (request: FastifyRequest) => {
      request.user = { userId: USER_ID } as AccessTokenPayload;
    },
    requireRelayAuth: async () => {},
  } as unknown as NotificationRouteOptions;

  await app.register(notificationRoutes, options);
  await app.ready();

  return { app, registrations };
}

function registerToken(app: FastifyInstance, deviceId?: string) {
  return app.inject({
    method: "POST",
    url: "/notifications/register-token",
    payload: { token: "fcm-token", platform: DevicePlatform.ios, ...(deviceId ? { deviceId } : {}) },
  });
}

describe("register-token deviceId gate", () => {
  it("accepts a registration without a deviceId while the gate is off", async () => {
    const { app, registrations } = await buildApp(false);

    const response = await registerToken(app);

    assert.equal(response.statusCode, 200);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]?.deviceId, undefined);
    await app.close();
  });

  it("rejects a registration without a deviceId once the gate is on", async () => {
    const { app, registrations } = await buildApp(true);

    const response = await registerToken(app);

    assert.equal(response.statusCode, 400);
    assert.equal(registrations.length, 0, "a rejected registration must not reach the presence service");
    await app.close();
  });

  it("still accepts a registration that supplies a deviceId once the gate is on", async () => {
    const { app, registrations } = await buildApp(true);

    const response = await registerToken(app, DEVICE_ID);

    assert.equal(response.statusCode, 200);
    assert.equal(registrations[0]?.deviceId, DEVICE_ID);
    await app.close();
  });

  it("rejects a malformed deviceId regardless of the gate", async () => {
    for (const required of [false, true]) {
      const { app } = await buildApp(required);

      const response = await registerToken(app, "not-a-uuid");

      assert.equal(response.statusCode, 400, `malformed deviceId must be rejected with gate=${required}`);
      await app.close();
    }
  });
});

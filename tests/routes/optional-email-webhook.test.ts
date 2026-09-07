import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { after, before, describe, it } from "node:test";
import { OptionalEmailPreferenceRepository } from "../../src/repositories/optional-email-preference-repo.js";
import { OptionalEmailWebhookEventRepository } from "../../src/repositories/optional-email-webhook-event-repo.js";
import { optionalEmailWebhookRoutes } from "../../src/routes/optional-email-webhook.js";
import { OptionalEmailWebhookService } from "../../src/services/optional-email-webhook-service.js";
import { ResendWebhookVerifier } from "../../src/services/resend-webhook-verifier.js";
import { OptionalEmailBlockReason } from "../../src/types/optional-email.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const SECRET_BYTES = Buffer.alloc(32, 3);
const SIGNING_SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

function signatureFor(input: { rawBody: string; messageId: string; timestamp: string }): string {
  const value = createHmac("sha256", SECRET_BYTES)
    .update(`${input.messageId}.${input.timestamp}.${input.rawBody}`, "utf8")
    .digest("base64");
  return `v1,${value}`;
}

describe("POST /webhooks/resend", () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  let userId: string;

  before(async () => {
    ctx = await createTestApp();
    userId = (await ctx.createUser()).userId;
    const service = new OptionalEmailWebhookService({
      eventRepo: new OptionalEmailWebhookEventRepository(ctx.dbAccessor),
      preferenceRepo: new OptionalEmailPreferenceRepository(ctx.dbAccessor),
      sendHistory: { findUserIdByProviderEmailId: async () => userId },
      clock: () => NOW,
    });
    app = Fastify();
    await app.register(optionalEmailWebhookRoutes, {
      service,
      verifier: new ResendWebhookVerifier({ signingSecret: SIGNING_SECRET, clock: () => NOW }),
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
    await ctx.cleanup();
  });

  it("verifies the raw request before suppressing and rejects a modified signature", async () => {
    const rawBody = JSON.stringify({
      type: "email.complained",
      data: {
        email_id: "resend-route-complaint-1",
        tags: { category: "optional_setup_reminder" },
      },
    });
    const messageId = "msg_route_complaint_1";
    const timestamp = String(Math.floor(NOW.getTime() / 1_000));
    const headers = {
      "content-type": "application/json",
      "svix-id": messageId,
      "svix-timestamp": timestamp,
      "svix-signature": signatureFor({ rawBody, messageId, timestamp }),
    };

    const valid = await app.inject({ method: "POST", url: "/webhooks/resend", headers, payload: rawBody });
    const invalid = await app.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: { ...headers, "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
      payload: rawBody,
    });

    assert.equal(valid.statusCode, 204);
    assert.equal(invalid.statusCode, 400);
    assert.equal(
      await new OptionalEmailPreferenceRepository(ctx.dbAccessor).findBlockReason({ userId }),
      OptionalEmailBlockReason.Suppressed,
    );
  });

  it("returns a retryable response when optional send history is not yet correlated", async () => {
    const retryApp = Fastify();
    await retryApp.register(optionalEmailWebhookRoutes, {
      service: new OptionalEmailWebhookService({
        eventRepo: new OptionalEmailWebhookEventRepository(ctx.dbAccessor),
        preferenceRepo: new OptionalEmailPreferenceRepository(ctx.dbAccessor),
        sendHistory: { findUserIdByProviderEmailId: async () => null },
        clock: () => NOW,
      }),
      verifier: new ResendWebhookVerifier({ signingSecret: SIGNING_SECRET, clock: () => NOW }),
    });
    await retryApp.ready();
    const rawBody = JSON.stringify({
      type: "email.complained",
      data: {
        email_id: "resend-route-not-correlated-yet",
        tags: { category: "optional_setup_reminder" },
      },
    });
    const messageId = "msg_route_not_correlated_1";
    const timestamp = String(Math.floor(NOW.getTime() / 1_000));

    try {
      const response = await retryApp.inject({
        method: "POST",
        url: "/webhooks/resend",
        headers: {
          "content-type": "application/json",
          "svix-id": messageId,
          "svix-timestamp": timestamp,
          "svix-signature": signatureFor({ rawBody, messageId, timestamp }),
        },
        payload: rawBody,
      });

      assert.equal(response.statusCode, 503);
      assert.equal(response.headers["retry-after"], "60");
    } finally {
      await retryApp.close();
    }
  });
});

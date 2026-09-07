import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OptionalEmailUnsubscribeService } from "../../src/services/optional-email-unsubscribe-service.js";
import type { OptionalEmailWebhookService } from "../../src/services/optional-email-webhook-service.js";
import type { ResendWebhookVerifier } from "../../src/services/resend-webhook-verifier.js";
import { createTestApp } from "../helpers/setup.js";

describe("optional email server wiring", () => {
  it("registers the public unsubscribe route only when its service is configured", async () => {
    const defaultContext = await createTestApp();
    try {
      const absent = await defaultContext.app.inject({
        method: "GET",
        url: "/email/optional/unsubscribe?token=signed-token",
      });
      assert.equal(absent.statusCode, 404);
    } finally {
      await defaultContext.cleanup();
    }

    const unsubscribeService = {
      isValid: ({ token }: { token: string }) => token === "signed-token",
      unsubscribe: async ({ token }: { token: string }) => token === "signed-token",
    } as unknown as OptionalEmailUnsubscribeService;
    const configuredContext = await createTestApp({
      optionalEmail: { unsubscribeService },
    });
    try {
      const available = await configuredContext.app.inject({
        method: "GET",
        url: "/email/optional/unsubscribe?token=signed-token",
      });
      assert.equal(available.statusCode, 200);
      assert.match(available.body, /Security and essential account messages are not affected/);
    } finally {
      await configuredContext.cleanup();
    }
  });

  it("registers the Resend webhook route only when its verifier and handler are configured", async () => {
    const verifier = {
      verify: () => ({ type: "email.sent", data: { email_id: "provider-id" } }),
    } as unknown as ResendWebhookVerifier;
    const service = {
      handleVerified: async () => ({ status: "processed", outcome: "ignored" }),
    } as unknown as OptionalEmailWebhookService;
    const context = await createTestApp({
      optionalEmail: { webhook: { verifier, service } },
    });
    try {
      const response = await context.app.inject({
        method: "POST",
        url: "/webhooks/resend",
        headers: {
          "content-type": "application/json",
          "svix-id": "msg_test",
          "svix-timestamp": "1",
          "svix-signature": "v1,test",
        },
        payload: '{"type":"email.sent"}',
      });

      assert.equal(response.statusCode, 204);
    } finally {
      await context.cleanup();
    }
  });
});

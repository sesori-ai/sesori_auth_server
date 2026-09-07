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

      const oneClickResponses = await Promise.all(
        Array.from({ length: 101 }, () =>
          configuredContext.app.inject({
            method: "POST",
            url: "/email/optional/unsubscribe?token=signed-token",
            remoteAddress: "203.0.113.8",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: "List-Unsubscribe=One-Click",
          }),
        ),
      );
      assert.equal(
        oneClickResponses.every((response) => response.statusCode === 200),
        true,
      );
    } finally {
      await configuredContext.cleanup();
    }
  });

  it("leaves the Resend webhook route absent by default", async () => {
    const context = await createTestApp();
    try {
      const response = await context.app.inject({ method: "POST", url: "/webhooks/resend" });
      assert.equal(response.statusCode, 404);
    } finally {
      await context.cleanup();
    }
  });

  it("exempts configured webhook callbacks from the global client-IP limiter", async () => {
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
      const responses = await Promise.all(
        Array.from({ length: 101 }, (_, index) =>
          context.app.inject({
            method: "POST",
            url: "/webhooks/resend",
            remoteAddress: "203.0.113.7",
            headers: {
              "content-type": "application/json",
              "svix-id": `msg_test_${index}`,
              "svix-timestamp": "1",
              "svix-signature": "v1,test",
            },
            payload: '{"type":"email.sent"}',
          }),
        ),
      );
      assert.equal(
        responses.every((response) => response.statusCode === 204),
        true,
      );
    } finally {
      await context.cleanup();
    }
  });
});

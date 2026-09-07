import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { OptionalEmailPreferenceRepository } from "../../src/repositories/optional-email-preference-repo.js";
import { OptionalEmailWebhookEventRepository } from "../../src/repositories/optional-email-webhook-event-repo.js";
import { OptionalEmailWebhookService } from "../../src/services/optional-email-webhook-service.js";
import { OptionalEmailBlockReason, OptionalEmailSuppressionReason } from "../../src/types/optional-email.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

describe("OptionalEmailWebhookService", () => {
  let ctx: TestContext;
  let preferenceRepo: OptionalEmailPreferenceRepository;
  let eventRepo: OptionalEmailWebhookEventRepository;

  before(async () => {
    ctx = await createTestApp();
    preferenceRepo = new OptionalEmailPreferenceRepository(ctx.dbAccessor);
    eventRepo = new OptionalEmailWebhookEventRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("suppresses an optional-mail hard bounce and recognizes a repeated Svix event id", async () => {
    const user = await ctx.createUser();
    let lookups = 0;
    const service = new OptionalEmailWebhookService({
      eventRepo,
      preferenceRepo,
      sendHistory: {
        findUserIdByProviderEmailId: async ({ providerEmailId }: { providerEmailId: string }) => {
          lookups += 1;
          return providerEmailId === "resend-email-1" ? user.userId : null;
        },
      },
      clock: () => NOW,
    });
    const input = {
      eventId: "msg_optional_hard_bounce_1",
      event: {
        type: "email.bounced",
        created_at: NOW.toISOString(),
        data: {
          email_id: "resend-email-1",
          bounce: { type: "Permanent", subType: "General" },
          tags: { category: "optional_setup_reminder" },
        },
      },
    };

    const first = await service.handleVerified(input);
    const replay = await service.handleVerified(input);

    assert.deepEqual(first, { status: "processed", outcome: "suppressed" });
    assert.deepEqual(replay, { status: "replayed" });
    assert.equal(lookups, 1);
    assert.equal(await preferenceRepo.findBlockReason({ userId: user.userId }), OptionalEmailBlockReason.Suppressed);
    assert.equal(
      (await preferenceRepo.findByUserId({ userId: user.userId }))?.suppressionReason,
      OptionalEmailSuppressionReason.HardBounce,
    );
  });

  it("suppresses optional reminders after a recipient complaint", async () => {
    const user = await ctx.createUser();
    const service = new OptionalEmailWebhookService({
      eventRepo,
      preferenceRepo,
      sendHistory: {
        findUserIdByProviderEmailId: async () => user.userId,
      },
      clock: () => NOW,
    });

    const result = await service.handleVerified({
      eventId: "msg_optional_complaint_1",
      event: {
        type: "email.complained",
        data: {
          email_id: "resend-email-complaint-1",
          tags: { category: "optional_setup_reminder" },
        },
      },
    });

    assert.deepEqual(result, { status: "processed", outcome: "suppressed" });
    assert.equal(
      (await preferenceRepo.findByUserId({ userId: user.userId }))?.suppressionReason,
      OptionalEmailSuppressionReason.Complaint,
    );
  });

  it("mirrors Resend provider suppression into optional-mail state", async () => {
    const user = await ctx.createUser();
    const service = new OptionalEmailWebhookService({
      eventRepo,
      preferenceRepo,
      sendHistory: { findUserIdByProviderEmailId: async () => user.userId },
      clock: () => NOW,
    });

    const result = await service.handleVerified({
      eventId: "msg_optional_provider_suppressed_1",
      event: {
        type: "email.suppressed",
        data: {
          email_id: "resend-email-suppressed-1",
          tags: { category: "optional_setup_reminder" },
        },
      },
    });

    assert.deepEqual(result, { status: "processed", outcome: "suppressed" });
    assert.equal(
      (await preferenceRepo.findByUserId({ userId: user.userId }))?.suppressionReason,
      OptionalEmailSuppressionReason.ProviderSuppressed,
    );
  });

  it("leaves an unmatched optional-mail event retryable without recording it as processed", async () => {
    const service = new OptionalEmailWebhookService({
      eventRepo,
      preferenceRepo,
      sendHistory: { findUserIdByProviderEmailId: async () => null },
      clock: () => NOW,
    });

    const result = await service.handleVerified({
      eventId: "msg_optional_unmatched_1",
      event: {
        type: "email.complained",
        data: {
          email_id: "resend-email-not-recorded-yet",
          tags: { category: "optional_setup_reminder" },
        },
      },
    });

    assert.deepEqual(result, { status: "retry" });
    assert.equal(await eventRepo.wasProcessed({ eventId: "msg_optional_unmatched_1" }), false);
  });

  it("records unrelated and non-permanent events as ignored without looking up a user", async () => {
    let lookups = 0;
    const service = new OptionalEmailWebhookService({
      eventRepo,
      preferenceRepo,
      sendHistory: {
        findUserIdByProviderEmailId: async () => {
          lookups += 1;
          return null;
        },
      },
      clock: () => NOW,
    });

    for (const input of [
      {
        eventId: "msg_unrelated_delivered_1",
        event: { type: "email.delivered", data: { email_id: "other-email", tags: { category: "account_security" } } },
      },
      {
        eventId: "msg_optional_transient_bounce_1",
        event: {
          type: "email.bounced",
          data: {
            email_id: "temporary-bounce",
            bounce: { type: "Transient" },
            tags: { category: "optional_setup_reminder" },
          },
        },
      },
    ]) {
      assert.deepEqual(await service.handleVerified(input), { status: "processed", outcome: "ignored" });
    }
    assert.equal(lookups, 0);
  });
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { OptionalEmailPreferenceRepository } from "../../src/repositories/optional-email-preference-repo.js";
import { OptionalEmailWebhookEventRepository } from "../../src/repositories/optional-email-webhook-event-repo.js";
import { OptionalEmailWebhookService } from "../../src/services/optional-email-webhook-service.js";
import {
  OptionalEmailBlockReason,
  OptionalEmailSuppressionReason,
  OptionalEmailWebhookOutcome,
  OptionalEmailWebhookStatus,
} from "../../src/types/optional-email.js";
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

  it("maps permanent provider outcomes to durable optional-mail suppression and replay", async () => {
    for (const testCase of [
      {
        suffix: "hard_bounce",
        type: "email.bounced",
        bounce: { type: "Permanent", subType: "General" },
        reason: OptionalEmailSuppressionReason.HardBounce,
      },
      { suffix: "complaint", type: "email.complained", reason: OptionalEmailSuppressionReason.Complaint },
      {
        suffix: "provider_suppressed",
        type: "email.suppressed",
        reason: OptionalEmailSuppressionReason.ProviderSuppressed,
      },
    ]) {
      const user = await ctx.createUser();
      let lookups = 0;
      const service = new OptionalEmailWebhookService({
        eventRepo,
        preferenceRepo,
        sendHistory: {
          findUserIdByProviderEmailId: async () => {
            lookups += 1;
            return user.userId;
          },
        },
        clock: () => NOW,
      });
      const input = {
        eventId: `msg_optional_${testCase.suffix}`,
        event: {
          type: testCase.type,
          data: {
            email_id: `resend-email-${testCase.suffix}`,
            ...(testCase.bounce ? { bounce: testCase.bounce } : {}),
            tags: { category: "optional_setup_reminder" },
          },
        },
      };

      assert.deepEqual(await service.handleVerified(input), {
        status: OptionalEmailWebhookStatus.Processed,
        outcome: OptionalEmailWebhookOutcome.Suppressed,
      });
      assert.deepEqual(await service.handleVerified(input), { status: OptionalEmailWebhookStatus.Replayed });
      assert.equal(lookups, 1);
      assert.equal((await preferenceRepo.findByUserId({ userId: user.userId }))?.suppressionReason, testCase.reason);
    }
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

    assert.deepEqual(result, { status: OptionalEmailWebhookStatus.Retry });
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
      assert.deepEqual(await service.handleVerified(input), {
        status: OptionalEmailWebhookStatus.Processed,
        outcome: OptionalEmailWebhookOutcome.Ignored,
      });
    }
    assert.equal(lookups, 0);
  });

  it("bounds concurrent replay races to repeated idempotent suppression writes", async () => {
    const user = await ctx.createUser();
    let lookups = 0;
    let releaseLookups: (() => void) | undefined;
    const bothLookupsStarted = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    const service = new OptionalEmailWebhookService({
      eventRepo,
      preferenceRepo,
      sendHistory: {
        findUserIdByProviderEmailId: async () => {
          lookups += 1;
          if (lookups === 2) {
            releaseLookups?.();
          }
          await bothLookupsStarted;
          return user.userId;
        },
      },
      clock: () => NOW,
    });
    const input = {
      eventId: "msg_concurrent_complaint_1",
      event: {
        type: "email.complained",
        data: {
          email_id: "resend-email-concurrent-1",
          tags: { category: "optional_setup_reminder" },
        },
      },
    };

    const results = await Promise.all([service.handleVerified(input), service.handleVerified(input)]);

    assert.equal(lookups, 2);
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      [OptionalEmailWebhookStatus.Processed, OptionalEmailWebhookStatus.Replayed].sort(),
    );
    assert.equal(await preferenceRepo.findBlockReason({ userId: user.userId }), OptionalEmailBlockReason.Suppressed);
  });
});

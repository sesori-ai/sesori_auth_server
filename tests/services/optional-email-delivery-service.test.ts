import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { OptionalEmailProviderSendInput } from "../../src/clients/resend-optional-email-adapter.js";
import { ResendOptionalEmailError } from "../../src/clients/resend-optional-email-adapter.js";
import { OptionalEmailDailyQuotaRepository } from "../../src/repositories/optional-email-daily-quota-repo.js";
import { OptionalEmailSendRepository } from "../../src/repositories/optional-email-send-repo.js";
import { OptionalEmailDeliveryService } from "../../src/services/optional-email-delivery-service.js";
import { OptionalEmailUnsubscribeTokenService } from "../../src/services/optional-email-unsubscribe-service.js";
import { OptionalEmailReminderKind } from "../../src/types/optional-email.js";
import { createTestApp, type TestAppContext } from "../helpers/setup.js";

describe("OptionalEmailDeliveryService", () => {
  let ctx: TestAppContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("rechecks eligibility immediately before one idempotent provider send", async () => {
    const user = await ctx.createUser();
    const now = new Date("2026-09-06T12:00:00.000Z");
    const tokenService = new OptionalEmailUnsubscribeTokenService({
      signingSecret: Buffer.alloc(32, 17),
    });
    let eligibilityChecks = 0;
    const providerCalls: OptionalEmailProviderSendInput[] = [];
    const sendRepo = new OptionalEmailSendRepository(ctx.dbAccessor);
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () => {
          eligibilityChecks += 1;
          return { eligible: true as const, recipient: "unique@example.test" };
        },
      },
      sendRepo,
      quotaRepo: new OptionalEmailDailyQuotaRepository(ctx.dbAccessor),
      provider: {
        send: async (input) => {
          providerCalls.push(input);
          return { providerEmailId: "resend-delivery-1" };
        },
      },
      tokenService,
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 80,
        testRecipient: "alex@sesori.com",
        testSendEnabled: false,
      },
      clock: () => now,
    });

    const result = await service.sendReminder({
      userId: user.userId,
      campaignId: "setup-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    });

    assert.equal(result.status, "sent");
    assert.equal(result.providerEmailId, "resend-delivery-1");
    assert.equal(eligibilityChecks, 2);
    assert.equal(providerCalls.length, 1);
    const message = providerCalls[0];
    assert.equal(message?.idempotencyKey, result.sendKey);
    assert.equal(message?.from, "Sesori <hello@updates.sesori.com>");
    assert.equal(message?.replyTo, "hello@sesori.com");
    assert.equal(message?.recipient, "unique@example.test");
    assert.equal(message?.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    const unsubscribeHeader = message?.headers["List-Unsubscribe"];
    assert.match(unsubscribeHeader ?? "", /^<https:\/\/api\.sesori\.com\/email\/optional\/unsubscribe\?token=/);
    const token = new URL((unsubscribeHeader ?? "").slice(1, -1)).searchParams.get("token");
    assert.equal(tokenService.verify({ token: token ?? "" }), user.userId);
    assert.match(message?.html ?? "", /Unsubscribe/);
    assert.match(message?.text ?? "", /Unsubscribe:/);
    assert.deepEqual(message?.tags, [
      { name: "category", value: "optional_setup_reminder" },
      { name: "campaign", value: "setup-2026-09" },
    ]);

    const stored = await sendRepo.findBySendKey({ sendKey: result.sendKey });
    assert.equal(stored?.status, "accepted");
    assert.equal(stored?.providerEmailId, "resend-delivery-1");
    assert.equal(stored?.attemptCount, 1);
  });

  it("blocks an already reserved reminder when unsubscribe appears before the provider call", async () => {
    const user = await ctx.createUser();
    const sendRepo = new OptionalEmailSendRepository(ctx.dbAccessor);
    let checks = 0;
    let providerCalls = 0;
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () => {
          checks += 1;
          return checks === 1
            ? { eligible: true as const, recipient: "queued@example.test" }
            : { eligible: false as const, reason: "unsubscribed" };
        },
      },
      sendRepo,
      quotaRepo: new OptionalEmailDailyQuotaRepository(ctx.dbAccessor),
      provider: {
        send: async () => {
          providerCalls += 1;
          return { providerEmailId: "must-not-send" };
        },
      },
      tokenService: new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(32, 18) }),
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 80,
        testRecipient: "alex@sesori.com",
        testSendEnabled: false,
      },
      clock: () => new Date("2026-09-06T13:00:00.000Z"),
    });

    const result = await service.sendReminder({
      userId: user.userId,
      campaignId: "queued-unsubscribe",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "unsubscribed");
    assert.equal(providerCalls, 0);
    const stored = await sendRepo.findBySendKey({ sendKey: result.sendKey });
    assert.equal(stored?.status, "blocked");
    assert.equal(stored?.lastBlockReason, "unsubscribed");
  });

  it("returns duplicate without another provider call or quota slot", async () => {
    const user = await ctx.createUser();
    const at = new Date("2026-09-07T12:00:00.000Z");
    let providerCalls = 0;
    const quotaRepo = new OptionalEmailDailyQuotaRepository(ctx.dbAccessor);
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () => ({ eligible: true as const, recipient: "duplicate@example.test" }),
      },
      sendRepo: new OptionalEmailSendRepository(ctx.dbAccessor),
      quotaRepo,
      provider: {
        send: async () => {
          providerCalls += 1;
          return { providerEmailId: "resend-duplicate-1" };
        },
      },
      tokenService: new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(32, 19) }),
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 80,
        testRecipient: "alex@sesori.com",
        testSendEnabled: false,
      },
      clock: () => at,
    });
    const input = {
      userId: user.userId,
      campaignId: "duplicate-delivery",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    };

    const first = await service.sendReminder(input);
    const second = await service.sendReminder(input);

    assert.equal(first.status, "sent");
    assert.equal(second.status, "duplicate");
    assert.equal(providerCalls, 1);
    assert.equal((await quotaRepo.getUsage({ at, dailyCap: 80 })).used, 1);
  });

  it("defers at the daily cap and reclaims the same send on the next UTC day", async () => {
    const firstUser = await ctx.createUser();
    const secondUser = await ctx.createUser();
    let now = new Date("2026-09-08T12:00:00.000Z");
    let providerCalls = 0;
    const sendRepo = new OptionalEmailSendRepository(ctx.dbAccessor);
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () => ({ eligible: true as const, recipient: "quota@example.test" }),
      },
      sendRepo,
      quotaRepo: new OptionalEmailDailyQuotaRepository(ctx.dbAccessor),
      provider: {
        send: async () => {
          providerCalls += 1;
          return { providerEmailId: `resend-quota-${providerCalls}` };
        },
      },
      tokenService: new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(32, 20) }),
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 1,
        testRecipient: "alex@sesori.com",
        testSendEnabled: false,
      },
      clock: () => now,
    });

    assert.equal(
      (
        await service.sendReminder({
          userId: firstUser.userId,
          campaignId: "quota-first",
          reminderKind: OptionalEmailReminderKind.BridgeSetup,
        })
      ).status,
      "sent",
    );
    const deferred = await service.sendReminder({
      userId: secondUser.userId,
      campaignId: "quota-second",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    });
    assert.equal(deferred.status, "daily_limit");
    assert.equal(providerCalls, 1);
    assert.equal((await sendRepo.findBySendKey({ sendKey: deferred.sendKey }))?.status, "deferred_daily_limit");

    now = new Date("2026-09-09T00:00:00.000Z");
    const retried = await service.sendReminder({
      userId: secondUser.userId,
      campaignId: "quota-second",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    });
    assert.equal(retried.status, "sent");
    assert.equal(providerCalls, 2);
  });

  it("persists a sanitized provider failure for an idempotent retry", async () => {
    const user = await ctx.createUser();
    const sendRepo = new OptionalEmailSendRepository(ctx.dbAccessor);
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () => ({ eligible: true as const, recipient: "retry@example.test" }),
      },
      sendRepo,
      quotaRepo: new OptionalEmailDailyQuotaRepository(ctx.dbAccessor),
      provider: {
        send: async () => {
          throw new ResendOptionalEmailError("unavailable");
        },
      },
      tokenService: new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(32, 21) }),
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 80,
        testRecipient: "alex@sesori.com",
        testSendEnabled: false,
      },
      clock: () => new Date("2026-09-10T12:00:00.000Z"),
    });

    const result = await service.sendReminder({
      userId: user.userId,
      campaignId: "provider-retry",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    });

    assert.equal(result.status, "provider_failed");
    assert.equal(result.code, "unavailable");
    const stored = await sendRepo.findBySendKey({ sendKey: result.sendKey });
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.lastFailureCode, "unavailable");
    assert.equal(stored?.attemptCount, 1);
  });

  it("blocks a failed retry and a later campaign after unsubscribe", async () => {
    const user = await ctx.createUser();
    let unsubscribed = false;
    let providerCalls = 0;
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () =>
          unsubscribed
            ? { eligible: false as const, reason: "unsubscribed" }
            : { eligible: true as const, recipient: "unsubscribe@example.test" },
      },
      sendRepo: new OptionalEmailSendRepository(ctx.dbAccessor),
      quotaRepo: new OptionalEmailDailyQuotaRepository(ctx.dbAccessor),
      provider: {
        send: async () => {
          providerCalls += 1;
          throw new ResendOptionalEmailError("unavailable");
        },
      },
      tokenService: new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(32, 22) }),
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 80,
        testRecipient: "alex@sesori.com",
        testSendEnabled: false,
      },
      clock: () => new Date("2026-09-11T12:00:00.000Z"),
    });
    const firstCampaign = {
      userId: user.userId,
      campaignId: "unsubscribe-retry",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    };

    assert.equal((await service.sendReminder(firstCampaign)).status, "provider_failed");
    unsubscribed = true;
    const retry = await service.sendReminder(firstCampaign);
    const laterCampaign = await service.sendReminder({
      ...firstCampaign,
      campaignId: "unsubscribe-later",
    });

    assert.deepEqual(retry, { status: "blocked", reason: "unsubscribed" });
    assert.deepEqual(laterCampaign, { status: "blocked", reason: "unsubscribed" });
    assert.equal(providerCalls, 1);
  });

  it("delivers distinct first-session reminder content", async () => {
    const user = await ctx.createUser();
    const sentMessages: OptionalEmailProviderSendInput[] = [];
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () => ({ eligible: true as const, recipient: "session@example.test" }),
      },
      sendRepo: new OptionalEmailSendRepository(ctx.dbAccessor),
      quotaRepo: new OptionalEmailDailyQuotaRepository(ctx.dbAccessor),
      provider: {
        send: async (input: OptionalEmailProviderSendInput) => {
          sentMessages.push(input);
          return { providerEmailId: "resend-first-session-1" };
        },
      },
      tokenService: new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(32, 23) }),
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 80,
        testRecipient: "alex@sesori.com",
        testSendEnabled: false,
      },
      clock: () => new Date("2026-09-12T12:00:00.000Z"),
    });

    const result = await service.sendReminder({
      userId: user.userId,
      campaignId: "first-session-reminder",
      reminderKind: OptionalEmailReminderKind.FirstSession,
    });

    assert.equal(result.status, "sent");
    assert.equal(sentMessages[0]?.subject, "Run your first coding session with Sesori");
    assert.match(sentMessages[0]?.text ?? "", /first coding session/);
  });

  it("keeps the test-send path disabled without any downstream access", async () => {
    let downstreamCalls = 0;
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () => {
          downstreamCalls += 1;
          return { eligible: true as const, recipient: "alex@sesori.com" };
        },
      },
      sendRepo: new OptionalEmailSendRepository(ctx.dbAccessor),
      quotaRepo: new OptionalEmailDailyQuotaRepository(ctx.dbAccessor),
      provider: {
        send: async () => {
          downstreamCalls += 1;
          return { providerEmailId: "must-not-send" };
        },
      },
      tokenService: new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(32, 24) }),
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 80,
        testRecipient: "alex@sesori.com",
        testSendEnabled: false,
      },
      clock: () => new Date("2026-09-13T12:00:00.000Z"),
    });

    const result = await service.sendTest({
      userId: "000000000000000000000001",
      recipient: "alex@sesori.com",
      operationId: "manual-1",
      templateKind: OptionalEmailReminderKind.BridgeSetup,
    });

    assert.deepEqual(result, { status: "blocked", reason: "test_sending_disabled" });
    assert.equal(downstreamCalls, 0);
  });

  it("rejects every test recipient outside the pinned allowlist", async () => {
    let downstreamCalls = 0;
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () => {
          downstreamCalls += 1;
          return { eligible: true as const, recipient: "other@example.test" };
        },
      },
      sendRepo: new OptionalEmailSendRepository(ctx.dbAccessor),
      quotaRepo: new OptionalEmailDailyQuotaRepository(ctx.dbAccessor),
      provider: {
        send: async () => {
          downstreamCalls += 1;
          return { providerEmailId: "must-not-send" };
        },
      },
      tokenService: new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(32, 25) }),
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 80,
        testRecipient: "alex@sesori.com",
        testSendEnabled: true,
      },
      clock: () => new Date("2026-09-13T13:00:00.000Z"),
    });

    const result = await service.sendTest({
      userId: "000000000000000000000001",
      recipient: "other@example.test",
      operationId: "manual-2",
      templateKind: OptionalEmailReminderKind.BridgeSetup,
    });

    assert.deepEqual(result, { status: "blocked", reason: "test_recipient_not_allowed" });
    assert.equal(downstreamCalls, 0);
  });

  it("sends only the pinned test recipient through normal quota and idempotency safeguards", async () => {
    const user = await ctx.createUser();
    let eligibilityChecks = 0;
    const providerMessages: OptionalEmailProviderSendInput[] = [];
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () => {
          eligibilityChecks += 1;
          return { eligible: true as const, recipient: "alex@sesori.com" };
        },
      },
      sendRepo: new OptionalEmailSendRepository(ctx.dbAccessor),
      quotaRepo: new OptionalEmailDailyQuotaRepository(ctx.dbAccessor),
      provider: {
        send: async (input: OptionalEmailProviderSendInput) => {
          providerMessages.push(input);
          return { providerEmailId: "resend-test-only-1" };
        },
      },
      tokenService: new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(32, 26) }),
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 80,
        testRecipient: "alex@sesori.com",
        testSendEnabled: true,
      },
      clock: () => new Date("2026-09-13T14:00:00.000Z"),
    });
    const input = {
      userId: user.userId,
      recipient: "alex@sesori.com",
      operationId: "manual_allowed_1",
      templateKind: OptionalEmailReminderKind.BridgeSetup,
    };

    const first = await service.sendTest(input);
    const duplicate = await service.sendTest(input);

    assert.equal(first.status, "sent");
    assert.equal(duplicate.status, "duplicate");
    assert.equal(eligibilityChecks, 3);
    assert.equal(providerMessages.length, 1);
    assert.equal(providerMessages[0]?.recipient, "alex@sesori.com");
    assert.match(providerMessages[0]?.idempotencyKey ?? "", /^optional\/[a-f0-9]{64}$/);
  });

  it("blocks the test path if resolved recipient changes before the provider call", async () => {
    const user = await ctx.createUser();
    let eligibilityChecks = 0;
    let providerCalls = 0;
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () => {
          eligibilityChecks += 1;
          return {
            eligible: true as const,
            recipient: eligibilityChecks === 1 ? "alex@sesori.com" : "changed@example.test",
          };
        },
      },
      sendRepo: new OptionalEmailSendRepository(ctx.dbAccessor),
      quotaRepo: new OptionalEmailDailyQuotaRepository(ctx.dbAccessor),
      provider: {
        send: async () => {
          providerCalls += 1;
          return { providerEmailId: "must-not-send" };
        },
      },
      tokenService: new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(32, 27) }),
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 80,
        testRecipient: "alex@sesori.com",
        testSendEnabled: true,
      },
      clock: () => new Date("2026-09-13T15:00:00.000Z"),
    });

    const result = await service.sendTest({
      userId: user.userId,
      recipient: "alex@sesori.com",
      operationId: "recipient_race_1",
      templateKind: OptionalEmailReminderKind.BridgeSetup,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "test_recipient_not_allowed");
    assert.equal(providerCalls, 0);
  });

  it("fails closed when a provider retry is outside the idempotency safety window", async () => {
    const user = await ctx.createUser();
    let now = new Date("2026-09-14T00:00:00.000Z");
    let providerCalls = 0;
    const service = new OptionalEmailDeliveryService({
      eligibility: {
        evaluate: async () => ({ eligible: true as const, recipient: "expired@example.test" }),
      },
      sendRepo: new OptionalEmailSendRepository(ctx.dbAccessor),
      quotaRepo: new OptionalEmailDailyQuotaRepository(ctx.dbAccessor),
      provider: {
        send: async () => {
          providerCalls += 1;
          throw new ResendOptionalEmailError("unavailable");
        },
      },
      tokenService: new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(32, 28) }),
      policy: {
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        publicBaseUrl: "https://api.sesori.com",
        dailyCap: 80,
        testRecipient: "alex@sesori.com",
        testSendEnabled: false,
      },
      clock: () => now,
    });
    const input = {
      userId: user.userId,
      campaignId: "expired-retry",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    };

    assert.equal((await service.sendReminder(input)).status, "provider_failed");
    now = new Date("2026-09-15T00:00:01.000Z");
    const expired = await service.sendReminder(input);

    assert.deepEqual(expired, { status: "blocked", reason: "retry_window_expired" });
    assert.equal(providerCalls, 1);
  });
});

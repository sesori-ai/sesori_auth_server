import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ObjectId } from "mongodb";
import { OptionalEmailSendRepository } from "../../src/repositories/optional-email-send-repo.js";
import {
  OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS,
  OPTIONAL_EMAIL_RESERVATION_LEASE_MS,
  OptionalEmailReminderKind,
  OptionalEmailSendBlockReason,
  OptionalEmailSendReservationOutcome,
  OptionalEmailSendStatus,
} from "../../src/types/optional-email.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

describe("OptionalEmailSendRepository", () => {
  let ctx: TestContext;
  let repo: OptionalEmailSendRepository;

  before(async () => {
    ctx = await createTestApp();
    repo = new OptionalEmailSendRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("atomically reserves one send per key without persisting a recipient address", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "optional/setup-2026-09/user-key-1",
      userId: user.userId,
      campaignId: "setup-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };

    const results = await Promise.all([repo.reserve(input), repo.reserve(input), repo.reserve(input)]);
    const statuses = results.map((result) => result.status).sort();
    const stored = await repo.findBySendKey({ sendKey: input.sendKey });

    assert.deepEqual(statuses, [
      OptionalEmailSendReservationOutcome.Duplicate,
      OptionalEmailSendReservationOutcome.Duplicate,
      OptionalEmailSendReservationOutcome.Reserved,
    ]);
    assert.equal(stored?.status, OptionalEmailSendStatus.Reserved);
    assert.equal(stored?.attemptCount, 0);
    assert.equal(stored?.userId.toHexString(), user.userId);
    assert.equal(stored && "recipient" in stored, false);
    assert.equal(stored && "email" in stored, false);
  });

  it("rejects immutable identity mismatches for an existing send key", async () => {
    const firstUser = await ctx.createUser();
    const secondUser = await ctx.createUser();
    const input = {
      sendKey: "optional/setup-2026-09/user-key-identity",
      userId: firstUser.userId,
      campaignId: "setup-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };
    await repo.reserve(input);

    await assert.rejects(() => repo.reserve({ ...input, userId: secondUser.userId }), /internal_server_error/);
    await assert.rejects(() => repo.reserve({ ...input, campaignId: "setup-2026-10" }), /internal_server_error/);
    await assert.rejects(
      () => repo.reserve({ ...input, reminderKind: OptionalEmailReminderKind.FirstSession }),
      /internal_server_error/,
    );
  });

  it("reclaims exactly one stale reservation while preserving an active lease", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "optional/setup-2026-09/user-key-stale-reservation",
      userId: user.userId,
      campaignId: "setup-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };
    const initialReservation = await repo.reserve(input);
    assert.equal(initialReservation.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.equal(typeof initialReservation.leaseId, "string");

    const activeLease = await repo.reserve({
      ...input,
      at: new Date(NOW.getTime() + OPTIONAL_EMAIL_RESERVATION_LEASE_MS),
    });
    assert.equal(activeLease.status, OptionalEmailSendReservationOutcome.Duplicate);

    const reclaimedAt = new Date(NOW.getTime() + OPTIONAL_EMAIL_RESERVATION_LEASE_MS + 1);
    const contenders = await Promise.all([
      repo.reserve({ ...input, at: reclaimedAt }),
      repo.reserve({ ...input, at: reclaimedAt }),
      repo.reserve({ ...input, at: reclaimedAt }),
    ]);
    assert.deepEqual(contenders.map((result) => result.status).sort(), [
      OptionalEmailSendReservationOutcome.Duplicate,
      OptionalEmailSendReservationOutcome.Duplicate,
      OptionalEmailSendReservationOutcome.Reserved,
    ]);
    const reclaimed = contenders.find((result) => result.status === OptionalEmailSendReservationOutcome.Reserved);
    assert.ok(reclaimed);
    assert.notEqual(reclaimed.leaseId, initialReservation.leaseId);

    const stored = await repo.findBySendKey({ sendKey: input.sendKey });
    assert.equal(stored?.status, OptionalEmailSendStatus.Reserved);
    assert.equal(stored?.attemptCount, 0);
    assert.equal(stored?.updatedAt.toISOString(), reclaimedAt.toISOString());

    const providerClaims = await Promise.all([
      repo.markInFlight({ sendKey: input.sendKey, leaseId: initialReservation.leaseId, at: reclaimedAt }),
      repo.markInFlight({ sendKey: input.sendKey, leaseId: reclaimed.leaseId, at: reclaimedAt }),
      repo.markInFlight({ sendKey: input.sendKey, leaseId: reclaimed.leaseId, at: reclaimedAt }),
    ]);
    assert.deepEqual(providerClaims.sort(), [false, false, true]);
    const claimed = await repo.findBySendKey({ sendKey: input.sendKey });
    assert.equal(claimed?.status, OptionalEmailSendStatus.InFlight);
    assert.equal(claimed?.attemptCount, 1);
  });

  it("rejects a reservation lease that expires before provider start", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "setup:bridge:user-expired-reservation-lease:v1",
      userId: user.userId,
      campaignId: "setup-reminders-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };

    const reservation = await repo.reserve(input);
    assert.equal(reservation.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.equal(
      await repo.markInFlight({
        sendKey: input.sendKey,
        leaseId: reservation.leaseId,
        at: new Date(NOW.getTime() + OPTIONAL_EMAIL_RESERVATION_LEASE_MS + 1),
      }),
      false,
    );

    const stored = await repo.findBySendKey({ sendKey: input.sendKey });
    assert.equal(stored?.status, OptionalEmailSendStatus.Reserved);
    assert.equal(stored?.attemptCount, 0);
  });

  it("rejects a retry lease that crosses the provider idempotency window before provider start", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "setup:bridge:user-retry-crosses-provider-window:v1",
      userId: user.userId,
      campaignId: "setup-reminders-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };

    const initial = await repo.reserve(input);
    assert.equal(initial.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.equal(await repo.markInFlight({ sendKey: input.sendKey, leaseId: initial.leaseId, at: NOW }), true);
    assert.equal(
      await repo.markFailed({
        sendKey: input.sendKey,
        leaseId: initial.leaseId,
        failureCode: "timeout",
        at: NOW,
      }),
      true,
    );

    const retryAt = new Date(NOW.getTime() + OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS - 1);
    const retry = await repo.reserve({ ...input, at: retryAt });
    assert.equal(retry.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.equal(
      await repo.markInFlight({
        sendKey: input.sendKey,
        leaseId: retry.leaseId,
        at: new Date(NOW.getTime() + OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS + 1),
      }),
      false,
    );

    const stored = await repo.findBySendKey({ sendKey: input.sendKey });
    assert.equal(stored?.status, OptionalEmailSendStatus.Reserved);
    assert.equal(stored?.attemptCount, 1);
  });

  it("persists only enum-backed block reasons", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "optional/setup-2026-09/user-key-blocked",
      userId: user.userId,
      campaignId: "setup-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };
    const reservation = await repo.reserve(input);
    assert.equal(reservation.status, OptionalEmailSendReservationOutcome.Reserved);

    assert.equal(
      await repo.markBlocked({
        sendKey: input.sendKey,
        leaseId: reservation.leaseId,
        reason: "unsubcribed" as OptionalEmailSendBlockReason,
        at: NOW,
      }),
      false,
    );
    assert.equal(
      await repo.markBlocked({
        sendKey: input.sendKey,
        leaseId: reservation.leaseId,
        reason: OptionalEmailSendBlockReason.MilestoneCompleted,
        at: NOW,
      }),
      true,
    );

    const stored = await repo.findBySendKey({ sendKey: input.sendKey });
    assert.equal(stored?.status, OptionalEmailSendStatus.Blocked);
    assert.equal(stored?.lastBlockReason, OptionalEmailSendBlockReason.MilestoneCompleted);
  });

  it("reclaims a stale in-flight attempt inside the idempotency window and fences its old lease", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "optional/setup-2026-09/user-key-stale-in-flight",
      userId: user.userId,
      campaignId: "setup-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };
    const initial = await repo.reserve(input);
    assert.equal(initial.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.equal(await repo.markInFlight({ sendKey: input.sendKey, leaseId: initial.leaseId, at: NOW }), true);

    const active = await repo.reserve({
      ...input,
      at: new Date(NOW.getTime() + OPTIONAL_EMAIL_RESERVATION_LEASE_MS),
    });
    assert.equal(active.status, OptionalEmailSendReservationOutcome.Duplicate);

    const reclaimedAt = new Date(NOW.getTime() + OPTIONAL_EMAIL_RESERVATION_LEASE_MS + 1);
    const reclaimed = await repo.reserve({ ...input, at: reclaimedAt });
    assert.equal(reclaimed.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.notEqual(reclaimed.leaseId, initial.leaseId);
    assert.equal(
      await repo.markInFlight({ sendKey: input.sendKey, leaseId: reclaimed.leaseId, at: reclaimedAt }),
      true,
    );
    assert.equal(
      await repo.markAccepted({
        sendKey: input.sendKey,
        leaseId: initial.leaseId,
        providerEmailId: "stale-provider-result",
        at: reclaimedAt,
      }),
      false,
    );
    assert.equal(
      await repo.markAccepted({
        sendKey: input.sendKey,
        leaseId: reclaimed.leaseId,
        providerEmailId: "recovered-provider-result",
        at: reclaimedAt,
      }),
      true,
    );

    const stored = await repo.findBySendKey({ sendKey: input.sendKey });
    assert.equal(stored?.status, OptionalEmailSendStatus.Accepted);
    assert.equal(stored?.attemptCount, 2);
    assert.equal(stored?.providerEmailId, "recovered-provider-result");
    assert.equal(stored?.activeLeaseId, undefined);
  });

  it("fences daily-limit deferral and issues a new lease for the retry", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "optional/setup-2026-09/user-key-deferred",
      userId: user.userId,
      campaignId: "setup-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };
    const initial = await repo.reserve(input);
    assert.equal(initial.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.equal(
      await repo.markDeferredForDailyLimit({
        sendKey: input.sendKey,
        leaseId: new ObjectId().toHexString(),
        at: NOW,
      }),
      false,
    );
    assert.equal(
      await repo.markDeferredForDailyLimit({ sendKey: input.sendKey, leaseId: initial.leaseId, at: NOW }),
      true,
    );

    const deferred = await repo.findBySendKey({ sendKey: input.sendKey });
    assert.equal(deferred?.status, OptionalEmailSendStatus.DeferredDailyLimit);
    assert.equal(deferred?.activeLeaseId, undefined);
    const retry = await repo.reserve({ ...input, at: new Date(NOW.getTime() + 1_000) });
    assert.equal(retry.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.notEqual(retry.leaseId, initial.leaseId);
  });

  it("fails closed when a stale in-flight attempt exceeds the provider idempotency window", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "optional/setup-2026-09/user-key-expired-in-flight",
      userId: user.userId,
      campaignId: "setup-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };
    const initial = await repo.reserve(input);
    assert.equal(initial.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.equal(await repo.markInFlight({ sendKey: input.sendKey, leaseId: initial.leaseId, at: NOW }), true);

    const expired = await repo.reserve({
      ...input,
      at: new Date(NOW.getTime() + OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS + 1),
    });
    assert.equal(expired.status, OptionalEmailSendReservationOutcome.RetryExpired);
    assert.equal(expired.send.status, OptionalEmailSendStatus.InFlight);
  });

  it("fails closed when a reclaimed in-flight attempt crashes past the idempotency window", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "optional/setup-2026-09/user-key-expired-reclaimed-in-flight",
      userId: user.userId,
      campaignId: "setup-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };
    const initial = await repo.reserve(input);
    assert.equal(initial.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.equal(await repo.markInFlight({ sendKey: input.sendKey, leaseId: initial.leaseId, at: NOW }), true);

    const recovered = await repo.reserve({
      ...input,
      at: new Date(NOW.getTime() + OPTIONAL_EMAIL_RESERVATION_LEASE_MS + 1),
    });
    assert.equal(recovered.status, OptionalEmailSendReservationOutcome.Reserved);

    const expired = await repo.reserve({
      ...input,
      at: new Date(NOW.getTime() + OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS + 1),
    });
    assert.equal(expired.status, OptionalEmailSendReservationOutcome.RetryExpired);
    assert.equal(expired.send.status, OptionalEmailSendStatus.Reserved);
  });

  it("records one provider attempt and keeps an accepted send permanently duplicate-blocked", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "optional/setup-2026-09/user-key-accepted",
      userId: user.userId,
      campaignId: "setup-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };
    const reservation = await repo.reserve(input);
    assert.equal(reservation.status, OptionalEmailSendReservationOutcome.Reserved);

    assert.equal(await repo.markInFlight({ sendKey: input.sendKey, leaseId: reservation.leaseId, at: NOW }), true);
    assert.equal(
      await repo.markAccepted({
        sendKey: input.sendKey,
        leaseId: reservation.leaseId,
        providerEmailId: "resend-email-accepted-1",
        at: new Date(NOW.getTime() + 1_000),
      }),
      true,
    );

    const stored = await repo.findBySendKey({ sendKey: input.sendKey });
    const duplicate = await repo.reserve({ ...input, at: new Date(NOW.getTime() + 10_000) });
    assert.equal(stored?.status, OptionalEmailSendStatus.Accepted);
    assert.equal(stored?.attemptCount, 1);
    assert.equal(stored?.firstProviderAttemptAt?.toISOString(), NOW.toISOString());
    assert.equal(stored?.providerEmailId, "resend-email-accepted-1");
    assert.equal(stored?.activeLeaseId, undefined);
    assert.equal(await repo.findUserIdByProviderEmailId({ providerEmailId: "resend-email-accepted-1" }), user.userId);
    assert.equal(duplicate.status, OptionalEmailSendReservationOutcome.Duplicate);
    assert.equal(duplicate.send.status, OptionalEmailSendStatus.Accepted);
  });

  it("reclaims a failed send only inside the provider idempotency safety window", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "optional/setup-2026-09/user-key-retry",
      userId: user.userId,
      campaignId: "setup-2026-09",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      at: NOW,
    };
    const reservation = await repo.reserve(input);
    assert.equal(reservation.status, OptionalEmailSendReservationOutcome.Reserved);
    await repo.markInFlight({ sendKey: input.sendKey, leaseId: reservation.leaseId, at: NOW });
    await repo.markFailed({
      sendKey: input.sendKey,
      leaseId: reservation.leaseId,
      failureCode: "provider_unavailable",
      at: new Date(NOW.getTime() + 1_000),
    });

    const retryAt = new Date(NOW.getTime() + 60 * 60 * 1_000);
    const retry = await repo.reserve({ ...input, at: retryAt });
    assert.equal(retry.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.equal(await repo.markInFlight({ sendKey: input.sendKey, leaseId: retry.leaseId, at: retryAt }), true);
    await repo.markFailed({
      sendKey: input.sendKey,
      leaseId: retry.leaseId,
      failureCode: "provider_unavailable",
      at: new Date(retryAt.getTime() + 1_000),
    });

    const stored = await repo.findBySendKey({ sendKey: input.sendKey });
    assert.equal(stored?.attemptCount, 2);
    assert.equal(stored?.firstProviderAttemptAt?.toISOString(), NOW.toISOString());
    assert.equal(stored?.lastProviderAttemptAt?.toISOString(), retryAt.toISOString());
    assert.equal(stored?.lastFailureCode, "provider_unavailable");

    const expired = await repo.reserve({
      ...input,
      at: new Date(NOW.getTime() + 23 * 60 * 60 * 1_000 + 1),
    });
    assert.equal(expired.status, OptionalEmailSendReservationOutcome.RetryExpired);
    assert.equal(expired.send.status, OptionalEmailSendStatus.Failed);
  });

  it("expires a daily-limit deferral that follows a provider attempt", async () => {
    const user = await ctx.createUser();
    const input = {
      sendKey: "setup:first_session:user-deferred-after-failure:v1",
      userId: user.userId,
      campaignId: "setup-reminders-2026-09",
      reminderKind: OptionalEmailReminderKind.FirstSession,
      at: NOW,
    };

    const initial = await repo.reserve(input);
    assert.equal(initial.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.equal(await repo.markInFlight({ sendKey: input.sendKey, leaseId: initial.leaseId, at: NOW }), true);
    assert.equal(
      await repo.markFailed({
        sendKey: input.sendKey,
        leaseId: initial.leaseId,
        failureCode: "timeout",
        at: NOW,
      }),
      true,
    );

    const retryAt = new Date(NOW.getTime() + 60_000);
    const retry = await repo.reserve({ ...input, at: retryAt });
    assert.equal(retry.status, OptionalEmailSendReservationOutcome.Reserved);
    assert.equal(
      await repo.markDeferredForDailyLimit({ sendKey: input.sendKey, leaseId: retry.leaseId, at: retryAt }),
      true,
    );

    const expired = await repo.reserve({
      ...input,
      at: new Date(NOW.getTime() + OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS + 1),
    });
    assert.equal(expired.status, OptionalEmailSendReservationOutcome.RetryExpired);
    assert.equal(expired.send.status, OptionalEmailSendStatus.DeferredDailyLimit);
  });
});

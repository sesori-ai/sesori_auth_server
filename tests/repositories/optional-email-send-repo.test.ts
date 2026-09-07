import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { OptionalEmailSendRepository } from "../../src/repositories/optional-email-send-repo.js";
import { OptionalEmailReminderKind } from "../../src/types/optional-email.js";
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

    assert.deepEqual(statuses, ["duplicate", "duplicate", "reserved"]);
    assert.equal(stored?.status, "reserved");
    assert.equal(stored?.attemptCount, 0);
    assert.equal(stored?.userId.toHexString(), user.userId);
    assert.equal(stored && "recipient" in stored, false);
    assert.equal(stored && "email" in stored, false);
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
    await repo.reserve(input);

    assert.equal(await repo.markInFlight({ sendKey: input.sendKey, at: NOW }), true);
    assert.equal(
      await repo.markAccepted({
        sendKey: input.sendKey,
        providerEmailId: "resend-email-accepted-1",
        at: new Date(NOW.getTime() + 1_000),
      }),
      true,
    );

    const stored = await repo.findBySendKey({ sendKey: input.sendKey });
    const duplicate = await repo.reserve({ ...input, at: new Date(NOW.getTime() + 10_000) });
    assert.equal(stored?.status, "accepted");
    assert.equal(stored?.attemptCount, 1);
    assert.equal(stored?.firstProviderAttemptAt?.toISOString(), NOW.toISOString());
    assert.equal(stored?.providerEmailId, "resend-email-accepted-1");
    assert.equal(await repo.findUserIdByProviderEmailId({ providerEmailId: "resend-email-accepted-1" }), user.userId);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.send.status, "accepted");
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
    await repo.reserve(input);
    await repo.markInFlight({ sendKey: input.sendKey, at: NOW });
    await repo.markFailed({
      sendKey: input.sendKey,
      failureCode: "provider_unavailable",
      at: new Date(NOW.getTime() + 1_000),
    });

    const retryAt = new Date(NOW.getTime() + 60 * 60 * 1_000);
    const retry = await repo.reserve({ ...input, at: retryAt });
    assert.equal(retry.status, "reserved");
    assert.equal(await repo.markInFlight({ sendKey: input.sendKey, at: retryAt }), true);
    await repo.markFailed({
      sendKey: input.sendKey,
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
    assert.equal(expired.status, "retry_expired");
    assert.equal(expired.send.status, "failed");
  });
});

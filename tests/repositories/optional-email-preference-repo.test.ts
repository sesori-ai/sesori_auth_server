import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ObjectId } from "mongodb";
import type { OptionalEmailPreference } from "../../src/models/documents.js";
import { OptionalEmailPreferenceRepository } from "../../src/repositories/optional-email-preference-repo.js";
import { OptionalEmailBlockReason, OptionalEmailSuppressionReason } from "../../src/types/optional-email.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("OptionalEmailPreferenceRepository", () => {
  let ctx: TestContext;
  let repo: OptionalEmailPreferenceRepository;

  before(async () => {
    ctx = await createTestApp();
    repo = new OptionalEmailPreferenceRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("treats an absent optional-mail preference as not locally blocked", async () => {
    const user = await ctx.createUser();

    assert.equal(await repo.findByUserId({ userId: user.userId }), null);
    assert.equal(await repo.findBlockReason({ userId: user.userId }), null);
  });

  it("persists an unsubscribe once and never resets it on replay", async () => {
    const user = await ctx.createUser();
    const first = new Date("2026-09-06T10:00:00.000Z");
    const replay = new Date("2026-09-06T11:00:00.000Z");

    await repo.unsubscribe({ userId: user.userId, at: first });
    await repo.unsubscribe({ userId: user.userId, at: replay });

    const stored = await repo.findByUserId({ userId: user.userId });
    assert.equal(stored?.unsubscribedAt?.toISOString(), first.toISOString());
    assert.equal(await repo.findBlockReason({ userId: user.userId }), OptionalEmailBlockReason.Unsubscribed);
  });

  it("durably suppresses hard bounces, complaints, and provider suppressions", async () => {
    for (const reason of [
      OptionalEmailSuppressionReason.HardBounce,
      OptionalEmailSuppressionReason.Complaint,
      OptionalEmailSuppressionReason.ProviderSuppressed,
    ]) {
      const user = await ctx.createUser();
      const at = new Date("2026-09-06T12:00:00.000Z");

      await repo.suppress({ userId: user.userId, reason, at });

      const stored = await repo.findByUserId({ userId: user.userId });
      assert.equal(stored?.suppressedAt?.toISOString(), at.toISOString());
      assert.equal(stored?.suppressionReason, reason);
      assert.equal(await repo.findBlockReason({ userId: user.userId }), OptionalEmailBlockReason.Suppressed);
    }
  });

  it("preserves both independent blockers when suppression follows unsubscribe", async () => {
    const user = await ctx.createUser();
    const unsubscribeAt = new Date("2026-09-06T10:00:00.000Z");
    const complaintAt = new Date("2026-09-06T12:00:00.000Z");

    await repo.unsubscribe({ userId: user.userId, at: unsubscribeAt });
    await repo.suppress({
      userId: user.userId,
      reason: OptionalEmailSuppressionReason.Complaint,
      at: complaintAt,
    });

    const stored = await repo.findByUserId({ userId: user.userId });
    assert.equal(stored?.unsubscribedAt?.toISOString(), unsubscribeAt.toISOString());
    assert.equal(stored?.suppressedAt?.toISOString(), complaintAt.toISOString());
    assert.equal(await repo.findBlockReason({ userId: user.userId }), OptionalEmailBlockReason.Unsubscribed);
  });

  it("keeps one preference document when concurrent unsubscribe requests race", async () => {
    const user = await ctx.createUser();
    const at = new Date("2026-09-06T10:00:00.000Z");

    await Promise.all([repo.unsubscribe({ userId: user.userId, at }), repo.unsubscribe({ userId: user.userId, at })]);

    const count = await ctx.dbAccessor
      .getCollection<OptionalEmailPreference>(MongoDbDatabase.Auth, AuthDbCollection.OptionalEmailPreferences)
      .countDocuments({ userId: new ObjectId(user.userId) });
    assert.equal(count, 1);
  });

  it("rejects malformed user IDs and dates at the repository boundary", async () => {
    await assert.rejects(() => repo.unsubscribe({ userId: "not-an-id", at: new Date() }), /internal_server_error/);
    await assert.rejects(
      () =>
        repo.suppress({
          userId: new ObjectId().toHexString(),
          reason: OptionalEmailSuppressionReason.HardBounce,
          at: new Date("invalid"),
        }),
      /internal_server_error/,
    );
  });
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Collection } from "mongodb";
import type { ActivationState } from "../../src/models/documents.js";
import { ActivationReminderKind, ActivationStateRepository } from "../../src/repositories/activation-state-repo.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

type ReminderFields = Partial<
  Pick<
    ActivationState,
    | "bridgeSetupAt"
    | "firstSessionAt"
    | "bridgeReminderBaseAt"
    | "sessionReminderBaseAt"
    | "bridgeReminder1SentAt"
    | "bridgeReminder2SentAt"
    | "sessionReminderSentAt"
  >
>;

describe("ActivationStateRepository reminders", () => {
  let ctx: TestContext;
  let repo: ActivationStateRepository;
  let collection: Collection<ActivationState>;

  before(async () => {
    ctx = await createTestApp();
    repo = new ActivationStateRepository(ctx.dbAccessor);
    collection = ctx.dbAccessor.getCollection<ActivationState>(MongoDbDatabase.Auth, AuthDbCollection.ActivationStates);
  });

  after(async () => {
    await ctx.cleanup();
  });

  async function seed(fields: ReminderFields): Promise<string> {
    const user = await ctx.createUser();
    const state = await repo.createIfAbsent(user.userId);
    await collection.updateOne({ _id: state._id }, { $set: fields });
    return user.userId;
  }

  it("finds staged bridge reminders by inclusive cutoff, completion, order, and limit", async () => {
    const cutoff = new Date("2026-07-15T12:00:00.000Z");
    const firstOld = await seed({ bridgeReminderBaseAt: new Date("2026-07-15T08:00:00.000Z") });
    const secondOld = await seed({
      bridgeReminderBaseAt: new Date("2026-07-15T08:15:00.000Z"),
      bridgeReminder1SentAt: cutoff,
    });
    const bridge2AlreadySent = await seed({
      bridgeReminderBaseAt: new Date("2026-07-15T09:00:00.000Z"),
      bridgeReminder2SentAt: cutoff,
    });
    const exactFirst = await seed({ bridgeReminderBaseAt: cutoff });
    const exactSecond = await seed({ bridgeReminderBaseAt: cutoff, bridgeReminder1SentAt: cutoff });
    const future = await seed({ bridgeReminderBaseAt: new Date(cutoff.getTime() + 1) });
    const completed = await seed({ bridgeReminderBaseAt: oldDate(), bridgeSetupAt: cutoff });
    await seed({ bridgeReminderBaseAt: null });

    const bridge1 = await repo.findDueReminders(ActivationReminderKind.Bridge1, cutoff, 10);
    const bridge2 = await repo.findDueReminders(ActivationReminderKind.Bridge2, cutoff, 10);
    const limited = await repo.findDueReminders(ActivationReminderKind.Bridge1, cutoff, 2);

    assert.deepEqual(
      bridge1.map((candidate) => candidate.userId),
      [firstOld, bridge2AlreadySent, exactFirst],
    );
    assert.deepEqual(
      bridge2.map((candidate) => candidate.userId),
      [secondOld, exactSecond],
    );
    assert.deepEqual(
      limited.map((candidate) => candidate.userId),
      [firstOld, bridge2AlreadySent],
    );
    assert.ok(!bridge1.some((candidate) => candidate.userId === future));
    assert.ok(!bridge1.some((candidate) => candidate.userId === completed));
    assert.ok(!bridge2.some((candidate) => candidate.userId === firstOld));
  });

  it("finds session reminders by inclusive cutoff and excludes completed or sent states", async () => {
    const cutoff = new Date("2026-07-15T12:00:00.000Z");
    const old = await seed({ sessionReminderBaseAt: new Date("2026-07-15T08:00:00.000Z") });
    const exact = await seed({ sessionReminderBaseAt: cutoff });
    const future = await seed({ sessionReminderBaseAt: new Date(cutoff.getTime() + 1) });
    const completed = await seed({ sessionReminderBaseAt: oldDate(), firstSessionAt: cutoff });
    const sent = await seed({ sessionReminderBaseAt: oldDate(), sessionReminderSentAt: cutoff });

    const due = await repo.findDueReminders(ActivationReminderKind.Session, cutoff, 10);

    assert.deepEqual(
      due.map((candidate) => candidate.userId),
      [old, exact],
    );
    assert.ok(!due.some((candidate) => candidate.userId === future));
    assert.ok(!due.some((candidate) => candidate.userId === completed));
    assert.ok(!due.some((candidate) => candidate.userId === sent));
  });

  it("rejects an invalid reminder batch limit", async () => {
    await assert.rejects(() => repo.findDueReminders(ActivationReminderKind.Bridge1, new Date(), 0), {
      message: "internal_server_error",
    });
  });

  it("checks eligibility and conditionally records independent sent markers", async () => {
    const cutoff = new Date("2026-07-15T12:00:00.000Z");
    const firstSentAt = new Date("2026-07-15T12:01:00.000Z");
    const laterSentAt = new Date("2026-07-15T12:02:00.000Z");
    const userId = await seed({ bridgeReminderBaseAt: oldDate() });

    assert.equal(await repo.isReminderStillDue(userId, ActivationReminderKind.Bridge1, cutoff), true);
    assert.equal(
      await repo.markReminderSentIfStillDue(userId, ActivationReminderKind.Bridge1, cutoff, firstSentAt),
      true,
    );
    assert.equal(
      await repo.markReminderSentIfStillDue(userId, ActivationReminderKind.Bridge1, cutoff, laterSentAt),
      false,
    );
    assert.equal(await repo.isReminderStillDue(userId, ActivationReminderKind.Bridge1, cutoff), false);
    assert.equal(await repo.isReminderStillDue(userId, ActivationReminderKind.Bridge2, cutoff), true);
    assert.equal(
      await repo.markReminderSentIfStillDue(userId, ActivationReminderKind.Bridge2, cutoff, laterSentAt),
      true,
    );

    const state = await repo.findByUserId(userId);
    assert.equal(state?.bridgeReminder1SentAt?.toISOString(), firstSentAt.toISOString());
    assert.equal(state?.bridgeReminder2SentAt?.toISOString(), laterSentAt.toISOString());
    assert.equal(state?.updatedAt.toISOString(), laterSentAt.toISOString());
  });

  it("does not check or mark a stale result after stage completion", async () => {
    const cutoff = new Date("2026-07-15T12:00:00.000Z");
    const userId = await seed({ sessionReminderBaseAt: oldDate() });
    await repo.recordMilestones(userId, { firstSessionAt: cutoff }, cutoff);

    assert.equal(await repo.isReminderStillDue(userId, ActivationReminderKind.Session, cutoff), false);
    assert.equal(await repo.markReminderSentIfStillDue(userId, ActivationReminderKind.Session, cutoff, cutoff), false);
    assert.equal(await repo.isReminderStillDue("invalid-id", ActivationReminderKind.Session, cutoff), false);
    assert.equal(
      await repo.markReminderSentIfStillDue("invalid-id", ActivationReminderKind.Session, cutoff, cutoff),
      false,
    );
    assert.equal((await repo.findByUserId(userId))?.sessionReminderSentAt, null);
  });

  it("allows exactly one concurrent sent-marker write", async () => {
    const cutoff = new Date("2026-07-15T12:00:00.000Z");
    const userId = await seed({ sessionReminderBaseAt: oldDate() });

    const results = await Promise.all([
      repo.markReminderSentIfStillDue(
        userId,
        ActivationReminderKind.Session,
        cutoff,
        new Date("2026-07-15T12:01:00.000Z"),
      ),
      repo.markReminderSentIfStillDue(
        userId,
        ActivationReminderKind.Session,
        cutoff,
        new Date("2026-07-15T12:02:00.000Z"),
      ),
    ]);

    assert.deepEqual([...results].sort(), [false, true]);
  });

  it("treats a matched eligibility CAS as successful even if the update is a no-op", async (t) => {
    t.mock.method(Collection.prototype, "updateOne", async () => ({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 0,
      upsertedCount: 0,
      upsertedId: null,
    }));

    assert.equal(
      await repo.markReminderSentIfStillDue(
        "000000000000000000000001",
        ActivationReminderKind.Session,
        new Date(),
        new Date(),
      ),
      true,
    );
  });

  function oldDate(): Date {
    return new Date("2026-07-15T08:30:00.000Z");
  }
});

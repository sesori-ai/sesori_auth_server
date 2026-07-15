import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Collection } from "mongodb";
import type { ActivationState } from "../../src/models/documents.js";
import { ActivationStateRepository } from "../../src/repositories/activation-state-repo.js";
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

  it("finds bridge reminders by inclusive cutoff, own marker, completion, order, and limit", async () => {
    const cutoff = new Date("2026-07-15T12:00:00.000Z");
    const old = await seed({ bridgeReminderBaseAt: new Date("2026-07-15T08:00:00.000Z") });
    const bridge2AlreadySent = await seed({
      bridgeReminderBaseAt: new Date("2026-07-15T09:00:00.000Z"),
      bridgeReminder2SentAt: cutoff,
    });
    const exact = await seed({ bridgeReminderBaseAt: cutoff });
    const future = await seed({ bridgeReminderBaseAt: new Date(cutoff.getTime() + 1) });
    const completed = await seed({ bridgeReminderBaseAt: oldDate(), bridgeSetupAt: cutoff });
    const bridge1AlreadySent = await seed({ bridgeReminderBaseAt: oldDate(), bridgeReminder1SentAt: cutoff });
    await seed({ bridgeReminderBaseAt: null });

    const bridge1 = await repo.findDueReminders("bridge_1", cutoff, 10);
    const bridge2 = await repo.findDueReminders("bridge_2", cutoff, 10);
    const limited = await repo.findDueReminders("bridge_1", cutoff, 2);

    assert.deepEqual(
      bridge1.map((candidate) => candidate.userId),
      [old, bridge2AlreadySent, exact],
    );
    assert.deepEqual(
      bridge2.map((candidate) => candidate.userId),
      [old, bridge1AlreadySent, exact],
    );
    assert.deepEqual(
      limited.map((candidate) => candidate.userId),
      [old, bridge2AlreadySent],
    );
    assert.ok(!bridge1.some((candidate) => candidate.userId === future));
    assert.ok(!bridge1.some((candidate) => candidate.userId === completed));
  });

  it("finds session reminders by inclusive cutoff and excludes completed or sent states", async () => {
    const cutoff = new Date("2026-07-15T12:00:00.000Z");
    const old = await seed({ sessionReminderBaseAt: new Date("2026-07-15T08:00:00.000Z") });
    const exact = await seed({ sessionReminderBaseAt: cutoff });
    const future = await seed({ sessionReminderBaseAt: new Date(cutoff.getTime() + 1) });
    const completed = await seed({ sessionReminderBaseAt: oldDate(), firstSessionAt: cutoff });
    const sent = await seed({ sessionReminderBaseAt: oldDate(), sessionReminderSentAt: cutoff });

    const due = await repo.findDueReminders("session", cutoff, 10);

    assert.deepEqual(
      due.map((candidate) => candidate.userId),
      [old, exact],
    );
    assert.ok(!due.some((candidate) => candidate.userId === future));
    assert.ok(!due.some((candidate) => candidate.userId === completed));
    assert.ok(!due.some((candidate) => candidate.userId === sent));
  });

  it("rejects an invalid reminder batch limit", async () => {
    await assert.rejects(() => repo.findDueReminders("bridge_1", new Date(), 0), {
      message: "internal_server_error",
    });
  });

  it("checks eligibility and conditionally records independent sent markers", async () => {
    const cutoff = new Date("2026-07-15T12:00:00.000Z");
    const firstSentAt = new Date("2026-07-15T12:01:00.000Z");
    const laterSentAt = new Date("2026-07-15T12:02:00.000Z");
    const userId = await seed({ bridgeReminderBaseAt: oldDate() });

    assert.equal(await repo.isReminderStillDue(userId, "bridge_1", cutoff), true);
    assert.equal(await repo.markReminderSentIfStillDue(userId, "bridge_1", cutoff, firstSentAt), true);
    assert.equal(await repo.markReminderSentIfStillDue(userId, "bridge_1", cutoff, laterSentAt), false);
    assert.equal(await repo.isReminderStillDue(userId, "bridge_1", cutoff), false);
    assert.equal(await repo.isReminderStillDue(userId, "bridge_2", cutoff), true);
    assert.equal(await repo.markReminderSentIfStillDue(userId, "bridge_2", cutoff, laterSentAt), true);

    const state = await repo.findByUserId(userId);
    assert.equal(state?.bridgeReminder1SentAt?.toISOString(), firstSentAt.toISOString());
    assert.equal(state?.bridgeReminder2SentAt?.toISOString(), laterSentAt.toISOString());
    assert.equal(state?.updatedAt.toISOString(), laterSentAt.toISOString());
  });

  it("does not check or mark a stale result after stage completion", async () => {
    const cutoff = new Date("2026-07-15T12:00:00.000Z");
    const userId = await seed({ sessionReminderBaseAt: oldDate() });
    await repo.recordMilestones(userId, { firstSessionAt: cutoff }, cutoff);

    assert.equal(await repo.isReminderStillDue(userId, "session", cutoff), false);
    assert.equal(await repo.markReminderSentIfStillDue(userId, "session", cutoff, cutoff), false);
    assert.equal(await repo.isReminderStillDue("invalid-id", "session", cutoff), false);
    assert.equal(await repo.markReminderSentIfStillDue("invalid-id", "session", cutoff, cutoff), false);
    assert.equal((await repo.findByUserId(userId))?.sessionReminderSentAt, null);
  });

  it("allows exactly one concurrent sent-marker write", async () => {
    const cutoff = new Date("2026-07-15T12:00:00.000Z");
    const userId = await seed({ sessionReminderBaseAt: oldDate() });

    const results = await Promise.all([
      repo.markReminderSentIfStillDue(userId, "session", cutoff, new Date("2026-07-15T12:01:00.000Z")),
      repo.markReminderSentIfStillDue(userId, "session", cutoff, new Date("2026-07-15T12:02:00.000Z")),
    ]);

    assert.deepEqual([...results].sort(), [false, true]);
  });

  function oldDate(): Date {
    return new Date("2026-07-15T08:30:00.000Z");
  }
});

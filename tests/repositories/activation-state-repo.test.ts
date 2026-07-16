import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Collection, MongoServerError } from "mongodb";
import { InternalServerError } from "../../src/lib/errors.js";
import { activationStateSchema, type ActivationState } from "../../src/models/documents.js";
import { ActivationStateRepository } from "../../src/repositories/activation-state-repo.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("ActivationStateRepository", () => {
  let ctx: TestContext;
  let repo: ActivationStateRepository;

  before(async () => {
    ctx = await createTestApp();
    repo = new ActivationStateRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("creates a complete dormant state for a user", async () => {
    const user = await ctx.createUser();
    const createdAt = new Date("2026-07-12T10:00:00.000Z");

    const state = await repo.createIfAbsent(user.userId, createdAt);

    assert.equal(state.userId.toHexString(), user.userId);
    assert.equal(state.createdAt.toISOString(), createdAt.toISOString());
    assert.equal(state.updatedAt.toISOString(), createdAt.toISOString());
    assert.equal(state.mobileSetupAt, null);
    assert.equal(state.bridgeSetupAt, null);
    assert.equal(state.firstSessionAt, null);
    assert.equal(state.bridgeReminderBaseAt, null);
    assert.equal(state.sessionReminderBaseAt, null);
    assert.equal(state.bridgeReminder1SentAt, null);
    assert.equal(state.bridgeReminder2SentAt, null);
    assert.equal(state.sessionReminderSentAt, null);
    assert.equal(state.backfilledAt, null);
    assert.equal(activationStateSchema.safeParse(state).success, true);
  });

  it("returns the existing state without resetting it", async () => {
    const user = await ctx.createUser();
    const firstAt = new Date("2026-07-12T10:00:00.000Z");
    const secondAt = new Date("2026-07-13T10:00:00.000Z");

    const first = await repo.createIfAbsent(user.userId, firstAt);
    const second = await repo.createIfAbsent(user.userId, secondAt);

    assert.equal(second._id.toHexString(), first._id.toHexString());
    assert.equal(second.createdAt.toISOString(), firstAt.toISOString());
    assert.equal(second.updatedAt.toISOString(), firstAt.toISOString());
  });

  it("returns the winner after losing a concurrent creation race", async (t) => {
    const user = await ctx.createUser();
    const winner = await repo.createIfAbsent(user.userId);
    t.mock.method(Collection.prototype, "findOneAndUpdate", async () => {
      throw new MongoServerError({ message: "duplicate key", code: 11000 });
    });

    const state = await repo.createIfAbsent(user.userId);

    assert.equal(state._id.toHexString(), winner._id.toHexString());
  });

  it("rejects creation with an invalid user id", async () => {
    await assert.rejects(
      () => repo.createIfAbsent("invalid-id"),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Invalid activation state userId",
    );
  });

  it("finds by user id and returns null for a missing state", async () => {
    const user = await ctx.createUser();
    const missingUser = await ctx.createUser();
    const created = await repo.createIfAbsent(user.userId);

    const found = await repo.findByUserId(user.userId);
    const missing = await repo.findByUserId(missingUser.userId);

    assert.equal(found?._id.toHexString(), created._id.toHexString());
    assert.equal(missing, null);
  });

  it("returns null when finding with an invalid user id", async () => {
    assert.equal(await repo.findByUserId("invalid-id"), null);
  });

  it("derives reminder baselines when mobile setup is recorded before bridge setup", async () => {
    const user = await ctx.createUser();
    const mobileAt = new Date("2026-07-12T10:00:00.000Z");
    const bridgeAt = new Date("2026-07-12T12:00:00.000Z");

    const mobileState = await repo.recordMilestones(user.userId, { mobileSetupAt: mobileAt }, mobileAt);
    const persistedMobileState = await repo.findByUserId(user.userId);
    const completeSetupState = await repo.recordMilestones(user.userId, { bridgeSetupAt: bridgeAt }, bridgeAt);

    assert.deepEqual(mobileState, persistedMobileState);
    assert.equal(mobileState.mobileSetupAt?.toISOString(), mobileAt.toISOString());
    assert.equal(mobileState.bridgeReminderBaseAt?.toISOString(), mobileAt.toISOString());
    assert.equal(mobileState.sessionReminderBaseAt, null);
    assert.equal(completeSetupState.bridgeSetupAt?.toISOString(), bridgeAt.toISOString());
    assert.equal(completeSetupState.sessionReminderBaseAt?.toISOString(), bridgeAt.toISOString());
  });

  it("derives the session baseline from the later mobile setup when events arrive out of order", async () => {
    const user = await ctx.createUser();
    const bridgeAt = new Date("2026-07-12T10:00:00.000Z");
    const mobileAt = new Date("2026-07-12T12:00:00.000Z");

    const bridgeState = await repo.recordMilestones(user.userId, { bridgeSetupAt: bridgeAt }, bridgeAt);
    const completeSetupState = await repo.recordMilestones(user.userId, { mobileSetupAt: mobileAt }, mobileAt);

    assert.equal(bridgeState.bridgeSetupAt?.toISOString(), bridgeAt.toISOString());
    assert.equal(bridgeState.bridgeReminderBaseAt, null);
    assert.equal(bridgeState.sessionReminderBaseAt, null);
    assert.equal(completeSetupState.bridgeReminderBaseAt?.toISOString(), mobileAt.toISOString());
    assert.equal(completeSetupState.sessionReminderBaseAt?.toISOString(), mobileAt.toISOString());
  });

  it("does not overwrite recorded milestones or reminder baselines", async () => {
    const user = await ctx.createUser();
    const firstMobileAt = new Date("2026-07-12T10:00:00.000Z");
    const firstBridgeAt = new Date("2026-07-12T12:00:00.000Z");
    const firstSessionAt = new Date("2026-07-12T13:00:00.000Z");
    await repo.recordMilestones(
      user.userId,
      { mobileSetupAt: firstMobileAt, bridgeSetupAt: firstBridgeAt, firstSessionAt },
      firstSessionAt,
    );

    const state = await repo.recordMilestones(
      user.userId,
      {
        mobileSetupAt: new Date("2026-07-13T10:00:00.000Z"),
        bridgeSetupAt: new Date("2026-07-13T12:00:00.000Z"),
        firstSessionAt: new Date("2026-07-13T13:00:00.000Z"),
      },
      new Date("2026-07-13T13:00:00.000Z"),
    );

    assert.equal(state.mobileSetupAt?.toISOString(), firstMobileAt.toISOString());
    assert.equal(state.bridgeSetupAt?.toISOString(), firstBridgeAt.toISOString());
    assert.equal(state.firstSessionAt?.toISOString(), firstSessionAt.toISOString());
    assert.equal(state.bridgeReminderBaseAt?.toISOString(), firstMobileAt.toISOString());
    assert.equal(state.sessionReminderBaseAt?.toISOString(), firstBridgeAt.toISOString());
  });

  it("derives valid baselines from concurrent first milestone writes", async () => {
    const user = await ctx.createUser();
    const mobileAt = new Date("2026-07-12T10:00:00.000Z");
    const bridgeAt = new Date("2026-07-12T12:00:00.000Z");

    await Promise.all([
      repo.recordMilestones(user.userId, { mobileSetupAt: mobileAt }, mobileAt),
      repo.recordMilestones(user.userId, { bridgeSetupAt: bridgeAt }, bridgeAt),
    ]);

    const state = await repo.findByUserId(user.userId);
    assert.equal(state?.mobileSetupAt?.toISOString(), mobileAt.toISOString());
    assert.equal(state?.bridgeSetupAt?.toISOString(), bridgeAt.toISOString());
    assert.equal(state?.bridgeReminderBaseAt?.toISOString(), mobileAt.toISOString());
    assert.equal(state?.sessionReminderBaseAt?.toISOString(), bridgeAt.toISOString());
  });

  it("retains the earlier first-session candidate when concurrent writes arrive out of order", async () => {
    const user = await ctx.createUser();
    const earlierAt = new Date("2026-07-12T10:00:00.000Z");
    const laterAt = new Date("2026-07-12T10:00:01.000Z");

    await repo.recordMilestones(user.userId, { firstSessionAt: laterAt }, laterAt);
    const state = await repo.recordMilestones(user.userId, { firstSessionAt: earlierAt }, earlierAt);

    assert.equal(state.firstSessionAt?.toISOString(), earlierAt.toISOString());
  });

  it("applies controlled backfill fields once and preserves them on rerun", async () => {
    const user = await ctx.createUser();
    const oldBaseline = new Date("2026-07-01T10:00:00.000Z");
    const mobileAt = new Date("2026-06-01T10:00:00.000Z");
    const backfilledAt = new Date("2026-07-16T10:00:00.000Z");
    const controlledBaseline = new Date("2026-07-16T12:00:00.000Z");
    const preciseSessionAt = new Date("2026-06-05T10:00:00.000Z");
    const approximateSessionAt = new Date("2026-06-04T00:00:00.000Z");
    const collection = ctx.dbAccessor.getCollection<ActivationState>(
      MongoDbDatabase.Auth,
      AuthDbCollection.ActivationStates,
    );
    const dormant = await repo.createIfAbsent(user.userId, oldBaseline);
    await collection.updateOne(
      { _id: dormant._id },
      { $set: { bridgeReminderBaseAt: oldBaseline, firstSessionAt: preciseSessionAt } },
    );

    const first = await repo.applyBackfill(user.userId, {
      mobileSetupAt: mobileAt,
      bridgeSetupAt: null,
      firstSessionAt: approximateSessionAt,
      reminderBaseAt: controlledBaseline,
      backfilledAt,
    });
    const second = await repo.applyBackfill(user.userId, {
      mobileSetupAt: new Date("2026-06-02T10:00:00.000Z"),
      bridgeSetupAt: new Date("2026-06-03T10:00:00.000Z"),
      firstSessionAt: null,
      reminderBaseAt: new Date("2026-07-17T10:00:00.000Z"),
      backfilledAt: new Date("2026-07-17T10:00:00.000Z"),
    });

    assert.equal(first.applied, true);
    assert.equal(first.state.mobileSetupAt?.toISOString(), mobileAt.toISOString());
    assert.equal(first.state.firstSessionAt?.toISOString(), preciseSessionAt.toISOString());
    assert.equal(first.state.bridgeReminderBaseAt?.toISOString(), controlledBaseline.toISOString());
    assert.equal(first.state.backfilledAt?.toISOString(), backfilledAt.toISOString());
    assert.equal(second.applied, false);
    assert.equal(second.state.bridgeSetupAt, null);
    assert.equal(second.state.bridgeReminderBaseAt?.toISOString(), controlledBaseline.toISOString());
    assert.equal(second.state.backfilledAt?.toISOString(), backfilledAt.toISOString());
  });

  it("does not schedule a stage completed or sent before the atomic backfill write", async () => {
    const user = await ctx.createUser();
    const at = new Date("2026-07-16T10:00:00.000Z");
    const oldBridgeBaseline = new Date("2026-06-01T10:00:00.000Z");
    const bridgeAt = new Date("2026-06-02T10:00:00.000Z");
    const sessionSentAt = new Date("2026-06-03T10:00:00.000Z");
    const collection = ctx.dbAccessor.getCollection<ActivationState>(
      MongoDbDatabase.Auth,
      AuthDbCollection.ActivationStates,
    );
    const dormant = await repo.createIfAbsent(user.userId, at);
    await collection.updateOne(
      { _id: dormant._id },
      {
        $set: {
          bridgeSetupAt: bridgeAt,
          bridgeReminderBaseAt: oldBridgeBaseline,
          sessionReminderSentAt: sessionSentAt,
        },
      },
    );

    const result = await repo.applyBackfill(user.userId, {
      mobileSetupAt: at,
      bridgeSetupAt: null,
      firstSessionAt: null,
      reminderBaseAt: at,
      backfilledAt: at,
    });

    assert.equal(result.applied, true);
    assert.equal(result.state.bridgeReminderBaseAt?.toISOString(), oldBridgeBaseline.toISOString());
    assert.equal(result.state.sessionReminderBaseAt, null);
    assert.equal(result.state.sessionReminderSentAt?.toISOString(), sessionSentAt.toISOString());
  });

  it("assigns the controlled baseline to the current stage after an organic milestone race", async () => {
    const user = await ctx.createUser();
    const mobileAt = new Date("2026-06-01T10:00:00.000Z");
    const bridgeAt = new Date("2026-06-02T10:00:00.000Z");
    const oldBridgeBaseline = new Date("2026-06-01T10:00:00.000Z");
    const controlledBaseline = new Date("2026-07-16T12:00:00.000Z");
    const backfilledAt = new Date("2026-07-16T10:00:00.000Z");
    await repo.recordMilestones(user.userId, { mobileSetupAt: mobileAt }, mobileAt);
    await repo.recordMilestones(user.userId, { bridgeSetupAt: bridgeAt }, bridgeAt);
    const beforeApply = new Date();

    const result = await repo.applyBackfill(user.userId, {
      mobileSetupAt: mobileAt,
      bridgeSetupAt: null,
      firstSessionAt: null,
      reminderBaseAt: controlledBaseline,
      backfilledAt,
    });

    assert.equal(result.applied, true);
    assert.equal(result.state.bridgeReminderBaseAt?.toISOString(), oldBridgeBaseline.toISOString());
    assert.equal(result.state.sessionReminderBaseAt?.toISOString(), controlledBaseline.toISOString());
    assert.equal(result.state.backfilledAt?.toISOString(), backfilledAt.toISOString());
    assert.ok(result.state.updatedAt.getTime() >= beforeApply.getTime());
  });

  it("creates the indexes needed by future reminder sweeps", async () => {
    const collection = ctx.dbAccessor.getCollection<ActivationState>(
      MongoDbDatabase.Auth,
      AuthDbCollection.ActivationStates,
    );
    const indexes = await collection.indexes();
    const indexByName = new Map(indexes.map((index) => [index.name, index]));

    assert.equal(indexByName.get("userId_1")?.unique, true);
    assert.deepEqual(indexByName.get("userId_1")?.key, { userId: 1 });
    assert.deepEqual(indexByName.get("bridgeSetupAt_1_bridgeReminder1SentAt_1_bridgeReminderBaseAt_1")?.key, {
      bridgeSetupAt: 1,
      bridgeReminder1SentAt: 1,
      bridgeReminderBaseAt: 1,
    });
    assert.deepEqual(indexByName.get("bridgeSetupAt_1_bridgeReminder2SentAt_1_bridgeReminderBaseAt_1")?.key, {
      bridgeSetupAt: 1,
      bridgeReminder2SentAt: 1,
      bridgeReminderBaseAt: 1,
    });
    assert.deepEqual(indexByName.get("firstSessionAt_1_sessionReminderSentAt_1_sessionReminderBaseAt_1")?.key, {
      firstSessionAt: 1,
      sessionReminderSentAt: 1,
      sessionReminderBaseAt: 1,
    });
  });
});

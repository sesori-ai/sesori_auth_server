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

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { ObjectId } from "mongodb";
import { InternalServerError } from "../../src/lib/errors.js";
import type { User } from "../../src/models/documents.js";
import { UserRepository } from "../../src/repositories/user-repo.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import {
  ProductAnalyticsPreference,
  ProductAnalyticsPreferenceUpdateOutcome,
} from "../../src/types/product-analytics.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("UserRepository", () => {
  let ctx: TestContext;
  let repo: UserRepository;

  before(async () => {
    ctx = await createTestApp();
    repo = new UserRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    await ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users).deleteMany({});
  });

  it("writes the initial product analytics preference for every new user", async () => {
    const user = await repo.create();
    const stored = await repo.findById(user._id.toHexString());

    assert.ok(stored);
    assert.equal(stored.productAnalyticsPreference, ProductAnalyticsPreference.Enabled);
    assert.equal(stored.productAnalyticsPreferenceUpdatedAt?.toISOString(), stored.createdAt.toISOString());
    assert.equal(stored.productAnalyticsPreferenceRevision, 1);
    assert.equal(stored.productAnalyticsPreferenceLastOperationId, null);
    assert.equal(stored.productAnalyticsExportSuppressedAt, undefined);
  });

  it("defaults a legacy user's missing preference at the read boundary", async () => {
    const userId = new ObjectId();
    const createdAt = new Date("2026-06-01T10:00:00.000Z");
    await ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users).insertOne({
      _id: userId,
      tokenVersion: 0,
      createdAt,
      updatedAt: createdAt,
    });

    assert.deepEqual(await repo.findProductAnalyticsPreference({ userId: userId.toHexString() }), {
      preference: ProductAnalyticsPreference.Enabled,
      updatedAt: createdAt,
      revision: 1,
    });
  });

  it("updates once and returns the committed result for a duplicate operation", async () => {
    const user = await repo.create();
    const userId = user._id.toHexString();
    const operationId = "11111111-1111-4111-8111-111111111111";

    const first = await repo.updateProductAnalyticsPreference({
      userId,
      preference: ProductAnalyticsPreference.Disabled,
      expectedRevision: 1,
      operationId,
    });
    const duplicate = await repo.updateProductAnalyticsPreference({
      userId,
      preference: ProductAnalyticsPreference.Disabled,
      expectedRevision: 1,
      operationId,
    });

    assert.equal(first?.outcome, ProductAnalyticsPreferenceUpdateOutcome.Updated);
    assert.equal(first?.record.preference, ProductAnalyticsPreference.Disabled);
    assert.equal(first?.record.revision, 2);
    assert.ok(first?.record.updatedAt);
    assert.deepEqual(duplicate, first);
    const stored = await repo.findById(userId);
    assert.equal(stored?.productAnalyticsPreferenceLastOperationId, operationId);
    assert.equal(stored?.updatedAt.toISOString(), first?.record.updatedAt.toISOString());
  });

  it("allows only one concurrent operation to claim an expected revision", async () => {
    const user = await repo.create();
    const userId = user._id.toHexString();
    const results = await Promise.all([
      repo.updateProductAnalyticsPreference({
        userId,
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: 1,
        operationId: "22222222-2222-4222-8222-222222222222",
      }),
      repo.updateProductAnalyticsPreference({
        userId,
        preference: ProductAnalyticsPreference.Enabled,
        expectedRevision: 1,
        operationId: "33333333-3333-4333-8333-333333333333",
      }),
    ]);

    assert.equal(
      results.filter((result) => result?.outcome === ProductAnalyticsPreferenceUpdateOutcome.Updated).length,
      1,
    );
    assert.equal(
      results.filter((result) => result?.outcome === ProductAnalyticsPreferenceUpdateOutcome.Conflict).length,
      1,
    );
    assert.equal(results[0]?.record.revision, 2);
    assert.deepEqual(results[0]?.record, results[1]?.record);
  });

  it("rejects a late stale enable after a newer disable", async () => {
    const user = await repo.create();
    const userId = user._id.toHexString();
    const disabled = await repo.updateProductAnalyticsPreference({
      userId,
      preference: ProductAnalyticsPreference.Disabled,
      expectedRevision: 1,
      operationId: "44444444-4444-4444-8444-444444444444",
    });
    const staleEnable = await repo.updateProductAnalyticsPreference({
      userId,
      preference: ProductAnalyticsPreference.Enabled,
      expectedRevision: 1,
      operationId: "55555555-5555-4555-8555-555555555555",
    });

    assert.equal(disabled?.outcome, ProductAnalyticsPreferenceUpdateOutcome.Updated);
    assert.equal(staleEnable?.outcome, ProductAnalyticsPreferenceUpdateOutcome.Conflict);
    assert.equal(staleEnable?.record.preference, ProductAnalyticsPreference.Disabled);
    assert.equal(staleEnable?.record.revision, 2);
  });

  it("does not re-enable a permanently export-suppressed account", async () => {
    const user = await repo.create();
    await ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users).updateOne(
      { _id: user._id },
      {
        $set: {
          productAnalyticsPreference: ProductAnalyticsPreference.Disabled,
          productAnalyticsExportSuppressedAt: new Date("2026-07-28T12:00:00.000Z"),
        },
      },
    );

    const result = await repo.updateProductAnalyticsPreference({
      userId: user._id.toHexString(),
      preference: ProductAnalyticsPreference.Enabled,
      expectedRevision: 1,
      operationId: "66666666-6666-4666-8666-666666666666",
    });

    assert.equal(result?.outcome, ProductAnalyticsPreferenceUpdateOutcome.Conflict);
    assert.equal(result?.record.preference, ProductAnalyticsPreference.Disabled);
    assert.equal(result?.record.revision, 1);
  });

  it("backfills only users missing required preference fields and is repeatable", async () => {
    const users = ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
    const firstCreatedAt = new Date("2026-05-01T10:00:00.000Z");
    const secondCreatedAt = new Date("2026-05-02T10:00:00.000Z");
    const firstId = new ObjectId();
    const secondId = new ObjectId();
    await users.insertMany([
      {
        _id: firstId,
        tokenVersion: 0,
        createdAt: firstCreatedAt,
        updatedAt: firstCreatedAt,
      },
      {
        _id: secondId,
        tokenVersion: 0,
        createdAt: secondCreatedAt,
        updatedAt: secondCreatedAt,
        productAnalyticsPreference: ProductAnalyticsPreference.Disabled,
      },
    ]);

    assert.equal(await repo.countUsersMissingProductAnalyticsPreference(), 2);
    assert.deepEqual(await repo.backfillProductAnalyticsPreference(), { matchedCount: 2, modifiedCount: 2 });
    assert.equal(await repo.countUsersMissingProductAnalyticsPreference(), 0);
    assert.deepEqual(await repo.findProductAnalyticsPreference({ userId: firstId.toHexString() }), {
      preference: ProductAnalyticsPreference.Enabled,
      updatedAt: firstCreatedAt,
      revision: 1,
    });
    assert.deepEqual(await repo.findProductAnalyticsPreference({ userId: secondId.toHexString() }), {
      preference: ProductAnalyticsPreference.Disabled,
      updatedAt: secondCreatedAt,
      revision: 1,
    });
    assert.deepEqual(await repo.backfillProductAnalyticsPreference(), { matchedCount: 0, modifiedCount: 0 });
  });

  it("iterates user ids in stable bounded batches", async () => {
    const userIds = ["000000000000000000000003", "000000000000000000000001", "000000000000000000000002"];
    for (const userId of userIds) {
      await repo.create(userId);
    }
    const createdAtOrBefore = new Date("2030-01-01T00:00:00.000Z");
    const laterUser = await repo.create("000000000000000000000004");
    await ctx.dbAccessor
      .getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users)
      .updateOne({ _id: laterUser._id }, { $set: { createdAt: new Date("2030-01-01T00:00:00.001Z") } });

    const first = await repo.findIdBatch(null, 2, createdAtOrBefore);
    const second = await repo.findIdBatch(first[1], 2, createdAtOrBefore);
    const exhausted = await repo.findIdBatch(second[0], 2, createdAtOrBefore);

    assert.deepEqual(first, ["000000000000000000000001", "000000000000000000000002"]);
    assert.deepEqual(second, ["000000000000000000000003"]);
    assert.deepEqual(exhausted, []);
  });

  it("rejects invalid limits and cursors", async () => {
    await assert.rejects(
      () => repo.findIdBatch(null, 0, new Date()),
      (error: unknown) => error instanceof InternalServerError && error.debugMessage === "Invalid user batch limit",
    );
    await assert.rejects(
      () => repo.findIdBatch("invalid", 1, new Date()),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Invalid user pagination cursor",
    );
    await assert.rejects(
      () => repo.findIdBatch(null, 1, new Date("invalid")),
      (error: unknown) => error instanceof InternalServerError && error.debugMessage === "Invalid user creation cutoff",
    );
  });
});

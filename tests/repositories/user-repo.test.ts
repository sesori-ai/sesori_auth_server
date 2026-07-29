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

  it("rejects a legacy user whose required preference was not backfilled", async () => {
    const userId = new ObjectId();
    const createdAt = new Date("2026-06-01T10:00:00.000Z");
    await ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users).insertOne({
      _id: userId,
      tokenVersion: 0,
      createdAt,
      updatedAt: createdAt,
    });

    await assert.rejects(
      () => repo.findProductAnalyticsPreference({ userId: userId.toHexString() }),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Invalid stored product analytics preference",
    );
  });

  it("reports a missing stored preference timestamp as an invariant failure", async () => {
    const userId = new ObjectId();
    const createdAt = new Date("2026-06-01T10:00:00.000Z");
    await ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users).insertOne({
      _id: userId,
      tokenVersion: 0,
      createdAt,
      updatedAt: createdAt,
      productAnalyticsPreference: ProductAnalyticsPreference.Enabled,
      productAnalyticsPreferenceRevision: 1,
      productAnalyticsPreferenceLastOperationId: null,
    });

    await assert.rejects(
      () => repo.findProductAnalyticsPreference({ userId: userId.toHexString() }),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Invalid stored product analytics preference",
    );
  });

  it("blocks startup while required preference state is missing", async () => {
    const createdAt = new Date("2026-06-01T10:00:00.000Z");
    await ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users).insertOne({
      _id: new ObjectId(),
      tokenVersion: 0,
      createdAt,
      updatedAt: createdAt,
    });

    await assert.rejects(
      () => repo.assertProductAnalyticsPreferenceBackfillComplete(),
      (error: unknown) =>
        error instanceof InternalServerError &&
        error.debugMessage === "Product analytics preference backfill is incomplete",
    );
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
    const mismatchedPreference = await repo.updateProductAnalyticsPreference({
      userId,
      preference: ProductAnalyticsPreference.Enabled,
      expectedRevision: 1,
      operationId,
    });
    const mismatchedRevision = await repo.updateProductAnalyticsPreference({
      userId,
      preference: ProductAnalyticsPreference.Disabled,
      expectedRevision: 2,
      operationId,
    });

    assert.equal(first?.outcome, ProductAnalyticsPreferenceUpdateOutcome.Updated);
    assert.equal(first?.record.preference, ProductAnalyticsPreference.Disabled);
    assert.equal(first?.record.revision, 2);
    assert.ok(first?.record.updatedAt);
    assert.deepEqual(duplicate, first);
    assert.equal(mismatchedPreference?.outcome, ProductAnalyticsPreferenceUpdateOutcome.Conflict);
    assert.deepEqual(mismatchedPreference?.record, first?.record);
    assert.equal(mismatchedRevision?.outcome, ProductAnalyticsPreferenceUpdateOutcome.Conflict);
    assert.deepEqual(mismatchedRevision?.record, first?.record);
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

  it("atomically suppresses export and preserves the first tombstone on retry", async () => {
    const user = await repo.create();
    const firstSuppressedAt = new Date("2026-07-28T12:00:00.000Z");
    const laterRetryAt = new Date("2026-07-28T13:00:00.000Z");

    const first = await repo.suppressProductAnalyticsExport({
      userId: user._id.toHexString(),
      suppressedAt: firstSuppressedAt,
    });
    const retry = await repo.suppressProductAnalyticsExport({
      userId: user._id.toHexString(),
      suppressedAt: laterRetryAt,
    });
    const stored = await repo.findById(user._id.toHexString());

    assert.equal(first?.preference.preference, ProductAnalyticsPreference.Disabled);
    assert.equal(first?.preference.revision, 2);
    assert.equal(first?.suppressedAt.toISOString(), firstSuppressedAt.toISOString());
    assert.deepEqual(retry, first);
    assert.equal(stored?.productAnalyticsExportSuppressedAt?.toISOString(), firstSuppressedAt.toISOString());
    assert.equal(stored?.productAnalyticsPreferenceLastOperationId, null);
  });

  it("preserves one tombstone when concurrent suppressions use different timestamps", async () => {
    const user = await repo.create();
    const candidates = [new Date("2026-07-28T12:00:00.000Z"), new Date("2026-07-28T13:00:00.000Z")];

    const results = await Promise.all(
      candidates.map((suppressedAt) =>
        repo.suppressProductAnalyticsExport({
          userId: user._id.toHexString(),
          suppressedAt,
        }),
      ),
    );
    const stored = await repo.findById(user._id.toHexString());

    assert.ok(results[0]);
    assert.ok(results[1]);
    assert.equal(results[0].suppressedAt.getTime(), results[1].suppressedAt.getTime());
    assert.equal(stored?.productAnalyticsExportSuppressedAt?.getTime(), results[0].suppressedAt.getTime());
    assert.equal(
      candidates.some((candidate) => candidate.getTime() === results[0].suppressedAt.getTime()),
      true,
    );
  });

  it("pages cutoff-safe export rows and preference changes without exposing ObjectIds", async () => {
    const users = ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
    const runCutoff = new Date("2026-07-28T12:00:00.000Z");
    const first = await repo.create("000000000000000000000001");
    const second = await repo.create("000000000000000000000002");
    const future = await repo.create("000000000000000000000003");
    await users.updateOne(
      { _id: first._id },
      {
        $set: {
          createdAt: new Date("2026-07-20T12:00:00.000Z"),
          productAnalyticsPreferenceUpdatedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
      },
    );
    await users.updateOne(
      { _id: second._id },
      {
        $set: {
          createdAt: new Date("2026-07-21T12:00:00.000Z"),
          productAnalyticsPreference: ProductAnalyticsPreference.Disabled,
          // This later current state must still prove that the document changed
          // after runCutoff; an upper-bound query could hide an earlier change.
          productAnalyticsPreferenceUpdatedAt: new Date("2026-07-28T12:15:00.000Z"),
        },
      },
    );
    await users.updateOne({ _id: future._id }, { $set: { createdAt: new Date("2026-07-29T12:00:00.000Z") } });

    const firstPage = await repo.findProductAnalyticsExportBatch({
      afterUserId: null,
      batchLimit: 1,
      createdAtOrBefore: runCutoff,
    });
    const secondPage = await repo.findProductAnalyticsExportBatch({
      afterUserId: firstPage[0].userId,
      batchLimit: 2,
      createdAtOrBefore: runCutoff,
    });
    const changes = await repo.findProductAnalyticsPreferenceChangeBatch({
      afterUserId: null,
      batchLimit: 10,
      changedAfter: runCutoff,
    });

    assert.equal(firstPage[0].userId, first._id.toHexString());
    assert.equal(Object.hasOwn(firstPage[0], "_id"), false);
    assert.equal(secondPage.length, 1);
    assert.equal(secondPage[0].userId, second._id.toHexString());
    assert.deepEqual(changes, [
      {
        userId: second._id.toHexString(),
        changedAt: new Date("2026-07-28T12:15:00.000Z"),
        exportSuppressedAt: null,
      },
      {
        userId: future._id.toHexString(),
        changedAt: future.productAnalyticsPreferenceUpdatedAt,
        exportSuppressedAt: null,
      },
    ]);
  });

  it("fails closed when an export projection contains malformed source state", async () => {
    const user = await repo.create();
    await ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users).updateOne(
      { _id: user._id },
      {
        $set: {
          productAnalyticsPreferenceUpdatedAt: "not-a-date" as unknown as Date,
        },
      },
    );

    await assert.rejects(
      () =>
        repo.findProductAnalyticsExportBatch({
          afterUserId: null,
          batchLimit: 10,
          createdAtOrBefore: new Date("2100-01-01T00:00:00.000Z"),
        }),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Invalid product analytics export source row",
    );
  });

  it("backfills only users missing required preference fields and is repeatable", async () => {
    const users = ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
    const firstCreatedAt = new Date("2026-05-01T10:00:00.000Z");
    const secondCreatedAt = new Date("2026-05-02T10:00:00.000Z");
    const firstId = new ObjectId();
    const secondId = new ObjectId();
    const lastOperationMissingId = new ObjectId();
    const suppressedId = new ObjectId();
    const inconsistentSuppressedId = new ObjectId();
    const suppressedAt = new Date("2026-06-01T10:00:00.000Z");
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
      {
        _id: lastOperationMissingId,
        tokenVersion: 0,
        createdAt: secondCreatedAt,
        updatedAt: secondCreatedAt,
        productAnalyticsPreference: ProductAnalyticsPreference.Enabled,
        productAnalyticsPreferenceUpdatedAt: secondCreatedAt,
        productAnalyticsPreferenceRevision: 1,
      },
      {
        _id: suppressedId,
        tokenVersion: 0,
        createdAt: secondCreatedAt,
        updatedAt: secondCreatedAt,
        productAnalyticsExportSuppressedAt: suppressedAt,
      },
      {
        _id: inconsistentSuppressedId,
        tokenVersion: 0,
        createdAt: secondCreatedAt,
        updatedAt: secondCreatedAt,
        productAnalyticsPreference: ProductAnalyticsPreference.Enabled,
        productAnalyticsPreferenceUpdatedAt: secondCreatedAt,
        productAnalyticsPreferenceRevision: 1,
        productAnalyticsPreferenceLastOperationId: null,
        productAnalyticsExportSuppressedAt: suppressedAt,
      },
    ]);

    const firstBatch = await repo.findProductAnalyticsPreferenceBackfillBatch({
      afterUserId: null,
      batchLimit: 2,
    });
    const secondBatch = await repo.findProductAnalyticsPreferenceBackfillBatch({
      afterUserId: firstBatch[1],
      batchLimit: 2,
    });
    const thirdBatch = await repo.findProductAnalyticsPreferenceBackfillBatch({
      afterUserId: secondBatch[1],
      batchLimit: 2,
    });
    assert.equal(firstBatch.length, 2);
    assert.equal(secondBatch.length, 2);
    assert.equal(thirdBatch.length, 1);
    assert.deepEqual(await repo.backfillProductAnalyticsPreferenceBatch({ userIds: firstBatch }), {
      matchedCount: 2,
      modifiedCount: 2,
    });
    assert.deepEqual(await repo.backfillProductAnalyticsPreferenceBatch({ userIds: secondBatch }), {
      matchedCount: 2,
      modifiedCount: 2,
    });
    assert.deepEqual(await repo.backfillProductAnalyticsPreferenceBatch({ userIds: thirdBatch }), {
      matchedCount: 1,
      modifiedCount: 1,
    });
    assert.deepEqual(await repo.findProductAnalyticsPreferenceBackfillBatch({ afterUserId: null, batchLimit: 2 }), []);
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
    assert.equal(
      (await repo.findById(lastOperationMissingId.toHexString()))?.productAnalyticsPreferenceLastOperationId,
      null,
    );
    const suppressed = await repo.findById(suppressedId.toHexString());
    assert.equal(suppressed?.productAnalyticsPreference, ProductAnalyticsPreference.Disabled);
    assert.equal(suppressed?.productAnalyticsExportSuppressedAt?.toISOString(), suppressedAt.toISOString());
    assert.equal(
      (await repo.findById(inconsistentSuppressedId.toHexString()))?.productAnalyticsPreference,
      ProductAnalyticsPreference.Disabled,
    );
  });

  it("rejects unsafe product analytics preference backfill batch inputs", async () => {
    await assert.rejects(
      () => repo.findProductAnalyticsPreferenceBackfillBatch({ afterUserId: null, batchLimit: 0 }),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Invalid preference backfill batch limit",
    );
    await assert.rejects(
      () => repo.findProductAnalyticsPreferenceBackfillBatch({ afterUserId: "invalid", batchLimit: 1 }),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Invalid preference backfill cursor",
    );
    await assert.rejects(
      () => repo.backfillProductAnalyticsPreferenceBatch({ userIds: ["invalid"] }),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Invalid preference backfill user ID",
    );
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

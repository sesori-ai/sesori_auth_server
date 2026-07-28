import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { ObjectId } from "mongodb";
import type { User } from "../../src/models/documents.js";
import {
  parseProductAnalyticsPreferenceBackfillArgs,
  runProductAnalyticsPreferenceBackfillCli,
} from "../../src/scripts/backfill-product-analytics-preference.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { ProductAnalyticsPreference } from "../../src/types/product-analytics.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("product analytics preference backfill CLI", () => {
  let ctx: TestContext;
  let logCalls: unknown[][];

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    logCalls = [];
    mock.method(console, "log", (...args: unknown[]) => {
      logCalls.push(args);
    });
    mock.method(console, "error", () => {});
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("parses validate, apply, and help modes", () => {
    assert.deepEqual(parseProductAnalyticsPreferenceBackfillArgs({ argv: [] }), {
      apply: false,
      help: false,
      batchLimit: 500,
    });
    assert.deepEqual(parseProductAnalyticsPreferenceBackfillArgs({ argv: ["--apply", "--batch-limit=25"] }), {
      apply: true,
      help: false,
      batchLimit: 25,
    });
    assert.deepEqual(parseProductAnalyticsPreferenceBackfillArgs({ argv: ["--help"] }), {
      apply: false,
      help: true,
      batchLimit: 500,
    });
    assert.throws(() => parseProductAnalyticsPreferenceBackfillArgs({ argv: ["--batch-limit=0"] }), /batch-limit/);
    assert.throws(() => parseProductAnalyticsPreferenceBackfillArgs({ argv: ["--batch-limit=1001"] }), /batch-limit/);
    assert.throws(() => parseProductAnalyticsPreferenceBackfillArgs({ argv: ["--unknown"] }), /Unknown argument/);
  });

  it("shows help without database configuration and rejects a missing URI", async () => {
    assert.equal(await runProductAnalyticsPreferenceBackfillCli({ argv: ["--help"], env: {} }), 0);
    assert.equal(await runProductAnalyticsPreferenceBackfillCli({ argv: [], env: {} }), 1);
  });

  it("counts without writing, applies idempotently, and validates zero missing", async () => {
    const userIds = [new ObjectId(), new ObjectId(), new ObjectId()];
    const createdAt = new Date("2026-05-20T10:00:00.000Z");
    const users = ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
    await users.insertMany(
      userIds.map((_id) => ({
        _id,
        tokenVersion: 0,
        createdAt,
        updatedAt: createdAt,
      })),
    );
    const mongodbUri = process.env.MONGODB_URI;
    assert.ok(mongodbUri);

    assert.equal(await runProductAnalyticsPreferenceBackfillCli({ argv: [], env: { MONGODB_URI: mongodbUri } }), 1);
    assert.equal((await users.findOne({ _id: userIds[0] }))?.productAnalyticsPreference, undefined);

    assert.equal(
      await runProductAnalyticsPreferenceBackfillCli({
        argv: ["--apply", "--batch-limit=1"],
        env: { MONGODB_URI: mongodbUri },
      }),
      0,
    );
    const backfilled = await users.findOne({ _id: userIds[0] });
    assert.equal(backfilled?.productAnalyticsPreference, ProductAnalyticsPreference.Enabled);
    assert.equal(backfilled?.productAnalyticsPreferenceUpdatedAt?.toISOString(), createdAt.toISOString());
    assert.equal(backfilled?.productAnalyticsPreferenceRevision, 1);
    assert.equal(backfilled?.productAnalyticsPreferenceLastOperationId, null);
    const batchProgress = logCalls.filter(
      (call) =>
        call[0] === "[ProductAnalyticsPreferenceBackfill] Batch completed" &&
        (call[1] as { mode?: string } | undefined)?.mode === "apply",
    );
    assert.equal(batchProgress.length, 3);
    assert.deepEqual(batchProgress[2]?.[1], {
      mode: "apply",
      batchesCompleted: 3,
      usersFound: 3,
      matchedCount: 3,
      modifiedCount: 3,
    });

    assert.equal(
      await runProductAnalyticsPreferenceBackfillCli({ argv: ["--apply"], env: { MONGODB_URI: mongodbUri } }),
      0,
    );
    assert.equal(await users.countDocuments({ productAnalyticsPreference: ProductAnalyticsPreference.Enabled }), 3);
  });
});

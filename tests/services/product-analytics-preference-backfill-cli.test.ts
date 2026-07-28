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

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    mock.method(console, "log", () => {});
    mock.method(console, "error", () => {});
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("parses validate, apply, and help modes", () => {
    assert.deepEqual(parseProductAnalyticsPreferenceBackfillArgs({ argv: [] }), {
      apply: false,
      help: false,
    });
    assert.deepEqual(parseProductAnalyticsPreferenceBackfillArgs({ argv: ["--apply"] }), {
      apply: true,
      help: false,
    });
    assert.deepEqual(parseProductAnalyticsPreferenceBackfillArgs({ argv: ["--help"] }), {
      apply: false,
      help: true,
    });
    assert.throws(() => parseProductAnalyticsPreferenceBackfillArgs({ argv: ["--unknown"] }), /Unknown argument/);
  });

  it("shows help without database configuration and rejects a missing URI", async () => {
    assert.equal(await runProductAnalyticsPreferenceBackfillCli({ argv: ["--help"], env: {} }), 0);
    assert.equal(await runProductAnalyticsPreferenceBackfillCli({ argv: [], env: {} }), 1);
  });

  it("counts without writing, applies idempotently, and validates zero missing", async () => {
    const userId = new ObjectId();
    const createdAt = new Date("2026-05-20T10:00:00.000Z");
    const users = ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
    await users.insertOne({
      _id: userId,
      tokenVersion: 0,
      createdAt,
      updatedAt: createdAt,
    });
    const mongodbUri = process.env.MONGODB_URI;
    assert.ok(mongodbUri);

    assert.equal(await runProductAnalyticsPreferenceBackfillCli({ argv: [], env: { MONGODB_URI: mongodbUri } }), 1);
    assert.equal((await users.findOne({ _id: userId }))?.productAnalyticsPreference, undefined);

    assert.equal(
      await runProductAnalyticsPreferenceBackfillCli({ argv: ["--apply"], env: { MONGODB_URI: mongodbUri } }),
      0,
    );
    const backfilled = await users.findOne({ _id: userId });
    assert.equal(backfilled?.productAnalyticsPreference, ProductAnalyticsPreference.Enabled);
    assert.equal(backfilled?.productAnalyticsPreferenceUpdatedAt?.toISOString(), createdAt.toISOString());
    assert.equal(backfilled?.productAnalyticsPreferenceRevision, 1);
    assert.equal(backfilled?.productAnalyticsPreferenceLastOperationId, null);

    assert.equal(
      await runProductAnalyticsPreferenceBackfillCli({ argv: ["--apply"], env: { MONGODB_URI: mongodbUri } }),
      0,
    );
  });
});

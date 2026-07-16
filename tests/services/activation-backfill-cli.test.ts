import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { ObjectId } from "mongodb";
import { parseActivationBackfillArgs, runActivationBackfillCli } from "../../src/scripts/backfill-activation.js";
import type { DeviceToken } from "../../src/models/documents.js";
import { ActivationStateRepository } from "../../src/repositories/activation-state-repo.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("activation backfill CLI", () => {
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
    mock.method(console, "warn", () => {});
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("parses safe dry-run defaults and explicit apply options", () => {
    const now = new Date("2026-07-16T10:00:00.000Z");

    assert.deepEqual(parseActivationBackfillArgs([], now), {
      apply: false,
      help: false,
      batchLimit: 500,
      jitterWindowMs: 86_400_000,
      backfillAt: now,
    });
    assert.deepEqual(parseActivationBackfillArgs(["--apply", "--batch-limit", "25", "--jitter-window-ms=0"], now), {
      apply: true,
      help: false,
      batchLimit: 25,
      jitterWindowMs: 0,
      backfillAt: now,
    });
    assert.throws(() => parseActivationBackfillArgs(["--batch-limit=0"], now), /--batch-limit/);
    assert.throws(() => parseActivationBackfillArgs(["--jitter-window-ms="], now), /requires a value/);
    assert.throws(() => parseActivationBackfillArgs(["--jitter-window-ms", " "], now), /requires a value/);
    assert.throws(() => parseActivationBackfillArgs(["--unknown"], now), /Unknown argument/);
  });

  it("shows help without requiring database configuration", async () => {
    assert.equal(await runActivationBackfillCli(["--help"], {}), 0);
  });

  it("reports missing or malformed database configuration", async () => {
    assert.equal(await runActivationBackfillCli([], {}), 1);
    assert.equal(await runActivationBackfillCli([], { MONGODB_URI: "not-a-uri" }), 1);
  });

  it("is read-only by default and writes only with --apply", async () => {
    const user = await ctx.createUser();
    const at = new Date("2026-06-01T10:00:00.000Z");
    await ctx.dbAccessor.getCollection<DeviceToken>(MongoDbDatabase.Auth, AuthDbCollection.DeviceTokens).insertOne({
      _id: new ObjectId(),
      userId: new ObjectId(user.userId),
      token: `cli-backfill-token-${user.userId}`,
      platform: "ios",
      createdAt: at,
      updatedAt: at,
    });
    const mongodbUri = process.env.MONGODB_URI;
    assert.ok(mongodbUri);
    const repo = new ActivationStateRepository(ctx.dbAccessor);

    assert.equal(await runActivationBackfillCli(["--jitter-window-ms=0"], { MONGODB_URI: mongodbUri }), 0);
    assert.equal(await repo.findByUserId(user.userId), null);

    assert.equal(await runActivationBackfillCli(["--apply", "--jitter-window-ms=0"], { MONGODB_URI: mongodbUri }), 0);
    const state = await repo.findByUserId(user.userId);
    assert.ok(state?.backfilledAt);
    assert.equal(state.bridgeReminderBaseAt?.toISOString(), state.backfilledAt.toISOString());
  });
});

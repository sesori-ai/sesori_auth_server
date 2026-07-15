import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ObjectId } from "mongodb";
import type { DailyUsage } from "../../src/models/documents.js";
import { DailyUsageRepository } from "../../src/repositories/daily-usage-repo.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("DailyUsageRepository", () => {
  let ctx: TestContext;
  let repo: DailyUsageRepository;

  before(async () => {
    ctx = await createTestApp();
    repo = new DailyUsageRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("findEarliestMetadataRequestAt returns the first day with metadata usage", async () => {
    const user = await ctx.createUser();
    const noMetadataAt = new Date("2026-07-09T08:00:00.000Z");
    const firstMetadataAt = new Date("2026-07-10T09:00:00.000Z");
    const laterMetadataAt = new Date("2026-07-12T10:00:00.000Z");
    const collection = ctx.dbAccessor.getCollection<DailyUsage>(MongoDbDatabase.Auth, AuthDbCollection.DailyUsage);
    await collection.insertMany([
      {
        _id: new ObjectId(),
        userId: new ObjectId(user.userId),
        date: "2026-07-09",
        transcriptionSeconds: 10,
        metadataRequestCount: 0,
        createdAt: noMetadataAt,
        updatedAt: noMetadataAt,
      },
      {
        _id: new ObjectId(),
        userId: new ObjectId(user.userId),
        date: "2026-07-10",
        transcriptionSeconds: 0,
        metadataRequestCount: 1,
        createdAt: firstMetadataAt,
        updatedAt: firstMetadataAt,
      },
      {
        _id: new ObjectId(),
        userId: new ObjectId(user.userId),
        date: "2026-07-12",
        transcriptionSeconds: 0,
        metadataRequestCount: 2,
        createdAt: laterMetadataAt,
        updatedAt: laterMetadataAt,
      },
    ]);

    assert.equal((await repo.findEarliestMetadataRequestAt(user.userId))?.toISOString(), firstMetadataAt.toISOString());
    assert.equal(await repo.findEarliestMetadataRequestAt("invalid-id"), null);
  });
});

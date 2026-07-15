import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ObjectId } from "mongodb";
import { InternalServerError } from "../../src/lib/errors.js";
import type { DeviceToken } from "../../src/models/documents.js";
import { DeviceTokenRepository } from "../../src/repositories/device-token-repo.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("DeviceTokenRepository", () => {
  let ctx: TestContext;
  let repo: DeviceTokenRepository;

  before(async () => {
    ctx = await createTestApp();
    repo = new DeviceTokenRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("upsertToken creates new token", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-create", "ios");

    const tokens = await repo.findByUserId(user.userId);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]?.token, "token-create");
    assert.equal(tokens[0]?.platform, "ios");
  });

  it("upsertToken with same token updates timestamp (idempotent)", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-idempotent", "ios");
    const first = await repo.findByUserId(user.userId);
    const firstCreatedAt = first[0]?.createdAt;
    const firstUpdatedAt = first[0]?.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await repo.upsertToken(user.userId, "token-idempotent", "android");

    const second = await repo.findByUserId(user.userId);
    assert.equal(second.length, 1);
    assert.equal(second[0]?.platform, "android");
    assert.ok(firstCreatedAt instanceof Date);
    assert.ok(firstUpdatedAt instanceof Date);
    assert.equal(second[0]?.createdAt.toISOString(), firstCreatedAt.toISOString());
    assert.ok(second[0]?.updatedAt instanceof Date);
    assert.ok((second[0]?.updatedAt.getTime() ?? 0) >= firstUpdatedAt.getTime());
  });

  it("upsertToken resets createdAt when a token moves to another user", async () => {
    const firstUser = await ctx.createUser();
    const secondUser = await ctx.createUser();

    await repo.upsertToken(firstUser.userId, "token-transferred", "ios");
    const firstRegistration = (await repo.findByUserId(firstUser.userId))[0];
    assert.ok(firstRegistration);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await repo.upsertToken(secondUser.userId, "token-transferred", "android");

    assert.equal((await repo.findByUserId(firstUser.userId)).length, 0);
    const transferred = (await repo.findByUserId(secondUser.userId))[0];
    assert.ok(transferred);
    assert.equal(transferred.platform, "android");
    assert.ok(transferred.createdAt.getTime() > firstRegistration.createdAt.getTime());
    assert.equal(transferred.createdAt.toISOString(), transferred.updatedAt.toISOString());
  });

  it("upsertToken rejects an invalid user id", async () => {
    await assert.rejects(
      () => repo.upsertToken("invalid-id", "token-invalid", "ios"),
      (error: unknown) => {
        assert.ok(error instanceof InternalServerError);
        assert.equal(error.debugMessage, "Invalid device token userId");
        return true;
      },
    );
  });

  it("findByUserId returns all tokens for user", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-list-1", "ios");
    await repo.upsertToken(user.userId, "token-list-2", "android");

    const tokens = await repo.findByUserId(user.userId);
    assert.equal(tokens.length, 2);
    assert.deepEqual(new Set(tokens.map((token) => token.token)), new Set(["token-list-1", "token-list-2"]));
  });

  it("findEarliestCreatedAt returns the first extant token registration", async () => {
    const user = await ctx.createUser();
    const firstAt = new Date("2026-07-10T10:00:00.000Z");
    const secondAt = new Date("2026-07-12T10:00:00.000Z");
    const collection = ctx.dbAccessor.getCollection<DeviceToken>(MongoDbDatabase.Auth, AuthDbCollection.DeviceTokens);
    await collection.insertMany([
      {
        _id: new ObjectId(),
        userId: new ObjectId(user.userId),
        token: `earliest-token-${user.userId}`,
        platform: "ios",
        createdAt: firstAt,
        updatedAt: firstAt,
      },
      {
        _id: new ObjectId(),
        userId: new ObjectId(user.userId),
        token: `later-token-${user.userId}`,
        platform: "android",
        createdAt: secondAt,
        updatedAt: secondAt,
      },
    ]);

    assert.equal((await repo.findEarliestCreatedAt(user.userId))?.toISOString(), firstAt.toISOString());
    assert.equal(await repo.findEarliestCreatedAt("invalid-id"), null);
    const index = (await collection.indexes()).find((candidate) => candidate.name === "userId_1_createdAt_1");
    assert.deepEqual(index?.key, { userId: 1, createdAt: 1 });
  });

  it("ensureIndexes removes the superseded user-only token index", async () => {
    const collection = ctx.dbAccessor.getCollection<DeviceToken>(MongoDbDatabase.Auth, AuthDbCollection.DeviceTokens);
    await collection.createIndex({ userId: 1 });

    await ctx.dbAccessor.ensureIndexes();

    const indexes = await collection.indexes();
    assert.equal(
      indexes.some((candidate) => candidate.name === "userId_1"),
      false,
    );
    assert.deepEqual(indexes.find((candidate) => candidate.name === "userId_1_createdAt_1")?.key, {
      userId: 1,
      createdAt: 1,
    });
  });

  it("ensureIndexes retains the user-only index when the compound replacement has conflicting options", async () => {
    const collection = ctx.dbAccessor.getCollection<DeviceToken>(MongoDbDatabase.Auth, AuthDbCollection.DeviceTokens);
    await collection.deleteMany({});
    await collection.dropIndex("userId_1_createdAt_1");
    await collection.createIndex({ userId: 1, createdAt: 1 }, { unique: true });
    await collection.createIndex({ userId: 1 });

    await ctx.dbAccessor.ensureIndexes();

    let indexes = await collection.indexes();
    assert.equal(
      indexes.some((candidate) => candidate.name === "userId_1"),
      true,
    );
    assert.equal(indexes.find((candidate) => candidate.name === "userId_1_createdAt_1")?.unique, true);

    await collection.dropIndex("userId_1_createdAt_1");
    await ctx.dbAccessor.ensureIndexes();
    indexes = await collection.indexes();
    assert.equal(
      indexes.some((candidate) => candidate.name === "userId_1"),
      false,
    );
    assert.equal(indexes.find((candidate) => candidate.name === "userId_1_createdAt_1")?.unique, undefined);
  });

  it("deleteByToken removes specific token", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-delete-one", "ios");
    await repo.deleteByToken("token-delete-one");

    const tokens = await repo.findByUserId(user.userId);
    assert.equal(tokens.length, 0);
  });

  it("deleteByTokens removes provided tokens", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-delete-many-1", "ios");
    await repo.upsertToken(user.userId, "token-delete-many-2", "android");
    await repo.upsertToken(user.userId, "token-delete-many-3", "ios");

    await repo.deleteByTokens(["token-delete-many-1", "token-delete-many-2"]);

    const tokens = await repo.findByUserId(user.userId);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]?.token, "token-delete-many-3");
  });

  it("deleteAllForUser removes all tokens for user", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-delete-all-1", "ios");
    await repo.upsertToken(user.userId, "token-delete-all-2", "android");

    await repo.deleteAllForUser(user.userId);

    const tokens = await repo.findByUserId(user.userId);
    assert.equal(tokens.length, 0);
  });
});

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

  it("upsertToken preserves createdAt for a same-owner mobile-to-mobile update", async () => {
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

  it("upsertToken preserves createdAt for a same-owner desktop-to-desktop update", async () => {
    const user = await ctx.createUser();
    await repo.upsertToken(user.userId, "token-desktop-retry", "macos");
    const first = (await repo.findByUserId(user.userId))[0];
    assert.ok(first);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await repo.upsertToken(user.userId, "token-desktop-retry", "linux");

    const updated = (await repo.findByUserId(user.userId))[0];
    assert.ok(updated);
    assert.equal(updated.platform, "linux");
    assert.equal(updated.createdAt.toISOString(), first.createdAt.toISOString());
    assert.ok(updated.updatedAt.getTime() > first.updatedAt.getTime());
  });

  it("upsertToken preserves createdAt for a same-owner mobile-to-desktop update", async () => {
    const user = await ctx.createUser();
    await repo.upsertToken(user.userId, "token-mobile-to-desktop", "ios");
    const first = (await repo.findByUserId(user.userId))[0];
    assert.ok(first);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await repo.upsertToken(user.userId, "token-mobile-to-desktop", "macos");

    const updated = (await repo.findByUserId(user.userId))[0];
    assert.ok(updated);
    assert.equal(updated.platform, "macos");
    assert.equal(updated.createdAt.toISOString(), first.createdAt.toISOString());
    assert.ok(updated.updatedAt.getTime() > first.updatedAt.getTime());
  });

  it("upsertToken resets createdAt for a same-owner desktop-to-mobile update", async () => {
    const user = await ctx.createUser();
    await repo.upsertToken(user.userId, "token-desktop-to-mobile", "macos");
    const first = (await repo.findByUserId(user.userId))[0];
    assert.ok(first);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await repo.upsertToken(user.userId, "token-desktop-to-mobile", "ios");

    const updated = (await repo.findByUserId(user.userId))[0];
    assert.ok(updated);
    assert.equal(updated.platform, "ios");
    assert.ok(updated.createdAt.getTime() > first.createdAt.getTime());
    assert.equal(updated.createdAt.toISOString(), updated.updatedAt.toISOString());
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

  it("upsertToken serializes concurrent owner and platform transitions", async () => {
    const firstUser = await ctx.createUser();
    const secondUser = await ctx.createUser();
    await repo.upsertToken(firstUser.userId, "token-concurrent-transition", "macos");
    const seeded = (await repo.findByUserId(firstUser.userId))[0];
    assert.ok(seeded);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await Promise.all([
      repo.upsertToken(firstUser.userId, "token-concurrent-transition", "ios"),
      repo.upsertToken(secondUser.userId, "token-concurrent-transition", "linux"),
    ]);

    const firstOwnerTokens = await repo.findByUserId(firstUser.userId);
    const secondOwnerTokens = await repo.findByUserId(secondUser.userId);
    assert.equal(firstOwnerTokens.length + secondOwnerTokens.length, 1);
    const finalToken = firstOwnerTokens[0] ?? secondOwnerTokens[0];
    assert.ok(finalToken);
    if (firstOwnerTokens.length === 1) {
      assert.equal(finalToken.platform, "ios");
    } else {
      assert.equal(finalToken.platform, "linux");
    }
    assert.ok(finalToken.createdAt.getTime() > seeded.createdAt.getTime());
    assert.equal(finalToken.createdAt.toISOString(), finalToken.updatedAt.toISOString());
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

  it("findEarliestMobileCreatedAt ignores desktop token registrations", async () => {
    const user = await ctx.createUser();
    const desktopAt = new Date("2026-07-09T10:00:00.000Z");
    const firstMobileAt = new Date("2026-07-10T10:00:00.000Z");
    const secondMobileAt = new Date("2026-07-12T10:00:00.000Z");
    const collection = ctx.dbAccessor.getCollection<DeviceToken>(MongoDbDatabase.Auth, AuthDbCollection.DeviceTokens);
    await collection.insertMany([
      {
        _id: new ObjectId(),
        userId: new ObjectId(user.userId),
        token: `desktop-token-${user.userId}`,
        platform: "macos",
        createdAt: desktopAt,
        updatedAt: desktopAt,
      },
      {
        _id: new ObjectId(),
        userId: new ObjectId(user.userId),
        token: `earliest-mobile-token-${user.userId}`,
        platform: "ios",
        createdAt: firstMobileAt,
        updatedAt: firstMobileAt,
      },
      {
        _id: new ObjectId(),
        userId: new ObjectId(user.userId),
        token: `later-mobile-token-${user.userId}`,
        platform: "android",
        createdAt: secondMobileAt,
        updatedAt: secondMobileAt,
      },
    ]);

    assert.equal((await repo.findEarliestMobileCreatedAt(user.userId))?.toISOString(), firstMobileAt.toISOString());
    assert.equal(await repo.findEarliestMobileCreatedAt("invalid-id"), null);
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

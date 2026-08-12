import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SettingsConfigurationRepository } from "../../src/repositories/settings-configuration-repo.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("SettingsConfigurationRepository", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("configures a unique compound index for each user and device", async () => {
    const collection = ctx.dbAccessor.getCollection(MongoDbDatabase.Auth, AuthDbCollection.SettingsConfiguration);

    const indexes = await collection.indexes();
    const compoundIndex = indexes.find(
      (index) => index.key.userId === 1 && index.key.deviceId === 1 && Object.keys(index.key).length === 2,
    );

    assert.ok(compoundIndex);
    assert.equal(compoundIndex.unique, true);
  });

  it("findByUserId returns only the calling user's devices", async () => {
    const owner = await ctx.createUser();
    const other = await ctx.createUser();
    const repo = new SettingsConfigurationRepository(ctx.dbAccessor);
    const firstDevice = randomUUID();
    const secondDevice = randomUUID();

    await repo.upsert(owner.userId, firstDevice, { notifications: { aiInteraction: false } });
    await repo.upsert(owner.userId, secondDevice, { notifications: { systemUpdate: false } });
    await repo.upsert(other.userId, randomUUID(), { notifications: { aiInteraction: false } });

    const documents = await repo.findByUserId(owner.userId);

    assert.deepEqual(documents.map((document) => document.deviceId).sort(), [firstDevice, secondDevice].sort());
    assert.ok(documents.every((document) => document.userId.toHexString() === owner.userId));
  });

  it("findByUserId returns an empty list for an invalid or unknown user", async () => {
    const repo = new SettingsConfigurationRepository(ctx.dbAccessor);

    assert.deepEqual(await repo.findByUserId("not-an-object-id"), []);
    assert.deepEqual(await repo.findByUserId("69b2aeaa1755fd6c00000000"), []);
  });

  it("upsert creates a sparse document scoped to the user and device", async () => {
    const user = await ctx.createUser();
    const repo = new SettingsConfigurationRepository(ctx.dbAccessor);
    const deviceId = randomUUID();

    const doc = await repo.upsert(user.userId, deviceId, { notifications: { aiInteraction: false } });

    assert.equal(doc.userId.toHexString(), user.userId);
    assert.equal(doc.deviceId, deviceId);
    assert.deepEqual(doc.notifications, { aiInteraction: false });
    assert.ok(doc.createdAt instanceof Date);
  });

  it("upsert merges a second toggle without dropping the first", async () => {
    const user = await ctx.createUser();
    const repo = new SettingsConfigurationRepository(ctx.dbAccessor);
    const deviceId = randomUUID();

    await repo.upsert(user.userId, deviceId, { notifications: { aiInteraction: false } });
    const merged = await repo.upsert(user.userId, deviceId, { notifications: { sessionMessage: false } });

    assert.deepEqual(merged.notifications, { aiInteraction: false, sessionMessage: false });
  });

  it("deleteByUserAndDevice removes one device without touching the account's others", async () => {
    const user = await ctx.createUser();
    const repo = new SettingsConfigurationRepository(ctx.dbAccessor);
    const target = randomUUID();
    const survivor = randomUUID();

    await repo.upsert(user.userId, target, { notifications: { aiInteraction: false } });
    await repo.upsert(user.userId, survivor, { notifications: { systemUpdate: false } });

    await repo.deleteByUserAndDevice(user.userId, target);

    const remaining = await repo.findByUserId(user.userId);
    assert.deepEqual(
      remaining.map((document) => document.deviceId),
      [survivor],
    );
  });

  it("deleteAllForUser removes every device the account registered", async () => {
    const owner = await ctx.createUser();
    const other = await ctx.createUser();
    const repo = new SettingsConfigurationRepository(ctx.dbAccessor);
    const sharedDeviceId = randomUUID();

    await repo.upsert(owner.userId, randomUUID(), { notifications: { aiInteraction: false } });
    await repo.upsert(owner.userId, randomUUID(), { notifications: { systemUpdate: false } });
    await repo.upsert(owner.userId, sharedDeviceId, { notifications: { sessionMessage: false } });
    await repo.upsert(other.userId, sharedDeviceId, { notifications: { aiInteraction: false } });

    await repo.deleteAllForUser(owner.userId);

    assert.deepEqual(await repo.findByUserId(owner.userId), []);

    // The shared deviceId proves the delete is scoped by account rather than by
    // device: another user's record for the same id must survive.
    const survivors = await repo.findByUserId(other.userId);
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0]?.deviceId, sharedDeviceId);
  });

  it("deleteAllForUser is a no-op for an invalid or unknown user", async () => {
    const user = await ctx.createUser();
    const repo = new SettingsConfigurationRepository(ctx.dbAccessor);
    await repo.upsert(user.userId, randomUUID(), { notifications: { aiInteraction: false } });

    await repo.deleteAllForUser("not-an-object-id");
    await repo.deleteAllForUser("69b2aeaa1755fd6c00000000");

    assert.equal((await repo.findByUserId(user.userId)).length, 1);
  });
});

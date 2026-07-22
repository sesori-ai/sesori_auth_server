import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SettingsConfigurationRepository } from "../../src/repositories/settings-configuration-repo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("SettingsConfigurationRepository", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
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
});

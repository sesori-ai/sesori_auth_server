import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { BridgeRepository } from "../../src/repositories/bridge-repo.js";
import type { Bridge } from "../../src/models/documents.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";

const HOST_KEY_A = "a".repeat(64);
const HOST_KEY_B = "b".repeat(64);

describe("BridgeRepository", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("register mints a bridgeId with the br_ prefix and ~16 chars", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);

    const bridge = await repo.register({ userId: user.userId, name: "Alex's MacBook", platform: "macos" });

    assert.match(bridge.bridgeId, /^br_[A-Za-z0-9_-]{8,32}$/);
    assert.equal(bridge.userId.toHexString(), user.userId);
    assert.equal(bridge.name, "Alex's MacBook");
    assert.equal(bridge.platform, "macos");
    assert.equal(bridge.status, "inactive");
    assert.equal(bridge.lastSeenAt, null);
    assert.equal(bridge.revokedAt, null);
    assert.ok(bridge.addedAt instanceof Date);
    assert.ok(bridge.createdAt instanceof Date);
  });

  it("findById returns the registered bridge", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Work Mac", platform: "macos" });

    const found = await repo.findById(bridge.bridgeId);
    assert.ok(found);
    assert.equal(found?.bridgeId, bridge.bridgeId);
    assert.equal(found?.name, "Work Mac");
  });

  it("findById returns null for unknown bridgeId", async () => {
    const repo = new BridgeRepository(ctx.dbAccessor);
    const found = await repo.findById("br_doesNotExist00");
    assert.equal(found, null);
  });

  it("findByIdForUser returns the bridge only for its owner", async () => {
    const userA = await ctx.createUser();
    const userB = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: userA.userId, name: "Laptop", platform: "linux" });

    const ownerFound = await repo.findByIdForUser(bridge.bridgeId, userA.userId);
    assert.ok(ownerFound);

    const otherFound = await repo.findByIdForUser(bridge.bridgeId, userB.userId);
    assert.equal(otherFound, null);
  });

  it("findByIdForUser returns null for revoked bridges", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Revoked", platform: "macos" });
    await repo.revoke(bridge.bridgeId, user.userId, new Date());

    const found = await repo.findByIdForUser(bridge.bridgeId, user.userId);
    assert.equal(found, null);
  });

  it("findByUserId returns empty array for invalid userId", async () => {
    const repo = new BridgeRepository(ctx.dbAccessor);

    const bridges = await repo.findByUserId("not-an-object-id");
    assert.deepEqual(bridges, []);
  });

  it("findByUserId returns only non-revoked bridges", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const b1 = await repo.register({ userId: user.userId, name: "Active 1", platform: "macos" });
    const b2 = await repo.register({ userId: user.userId, name: "To Revoke", platform: "windows" });
    await repo.revoke(b2.bridgeId, user.userId, new Date());

    const bridges = await repo.findByUserId(user.userId);
    assert.equal(bridges.length, 1);
    assert.equal(bridges[0]?.bridgeId, b1.bridgeId);
  });

  it("findEarliestAddedAt includes revoked bridges", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const first = await repo.register({ userId: user.userId, name: "First", platform: "macos" });
    const second = await repo.register({ userId: user.userId, name: "Second", platform: "linux" });
    const firstAt = new Date("2026-07-10T10:00:00.000Z");
    const secondAt = new Date("2026-07-12T10:00:00.000Z");
    const collection = ctx.dbAccessor.getCollection<Bridge>(MongoDbDatabase.Auth, AuthDbCollection.Bridges);
    await collection.updateOne({ bridgeId: first.bridgeId }, { $set: { addedAt: firstAt } });
    await collection.updateOne({ bridgeId: second.bridgeId }, { $set: { addedAt: secondAt } });
    await repo.revoke(first.bridgeId, user.userId, new Date("2026-07-13T10:00:00.000Z"));

    assert.equal((await repo.findEarliestAddedAt(user.userId))?.toISOString(), firstAt.toISOString());
    assert.equal(await repo.findEarliestAddedAt("invalid-id"), null);
    const index = (await collection.indexes()).find((candidate) => candidate.name === "userId_1_addedAt_1");
    assert.deepEqual(index?.key, { userId: 1, addedAt: 1 });
  });

  it("register is not an upsert — second call creates a new row", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const first = await repo.register({ userId: user.userId, name: "Same Name", platform: "macos" });
    const second = await repo.register({ userId: user.userId, name: "Same Name", platform: "macos" });

    assert.notEqual(first.bridgeId, second.bridgeId);
    const bridges = await repo.findByUserId(user.userId);
    assert.equal(bridges.length, 2);
  });

  it("updateForUser updates name and platform for the owner", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Old Name", platform: "macos" });

    const updated = await repo.updateForUser(bridge.bridgeId, user.userId, { name: "New Name", platform: "linux" });

    assert.ok(updated);
    assert.equal(updated?.bridgeId, bridge.bridgeId);
    assert.equal(updated?.name, "New Name");
    assert.equal(updated?.platform, "linux");
    assert.equal(updated?.addedAt.toISOString(), bridge.addedAt.toISOString());
  });

  it("updateForUser returns null for foreign, invalid-owner, or revoked bridges", async () => {
    const owner = await ctx.createUser();
    const stranger = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: owner.userId, name: "Bridge", platform: "macos" });

    const wrongOwner = await repo.updateForUser(bridge.bridgeId, stranger.userId, { name: "X", platform: "linux" });
    assert.equal(wrongOwner, null);

    const invalidOwner = await repo.updateForUser(bridge.bridgeId, "not-an-object-id", {
      name: "X",
      platform: "linux",
    });
    assert.equal(invalidOwner, null);

    await repo.revoke(bridge.bridgeId, owner.userId, new Date());
    const revoked = await repo.updateForUser(bridge.bridgeId, owner.userId, { name: "X", platform: "linux" });
    assert.equal(revoked, null);

    const after = await repo.findById(bridge.bridgeId);
    assert.equal(after?.name, "Bridge");
  });

  it("register stores a supplied hostKey and omits the field otherwise", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);

    const keyed = await repo.register({ userId: user.userId, name: "Keyed", platform: "macos", hostKey: HOST_KEY_A });
    const unkeyed = await repo.register({ userId: user.userId, name: "Unkeyed", platform: "macos", hostKey: null });

    assert.equal((await repo.findById(keyed.bridgeId))?.hostKey, HOST_KEY_A);
    assert.ok(!("hostKey" in ((await repo.findById(unkeyed.bridgeId)) ?? {})));
  });

  it("updateForUser stores a non-null hostKey and leaves it unchanged for null", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Bridge", platform: "macos", hostKey: null });

    await repo.updateForUser(bridge.bridgeId, user.userId, { name: "Bridge", platform: "macos", hostKey: HOST_KEY_A });
    assert.equal((await repo.findById(bridge.bridgeId))?.hostKey, HOST_KEY_A);

    await repo.updateForUser(bridge.bridgeId, user.userId, { name: "Renamed", platform: "macos", hostKey: null });
    const after = await repo.findById(bridge.bridgeId);
    assert.equal(after?.name, "Renamed");
    assert.equal(after?.hostKey, HOST_KEY_A);
  });

  it("updateByHostKeyForUser picks the most recently seen live bridge of that user", async () => {
    const owner = await ctx.createUser();
    const stranger = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    // Registered first but seen last: lastSeenAt, not addedAt, decides.
    const seenRecently = await repo.register({
      userId: owner.userId,
      name: "Seen recently",
      platform: "macos",
      hostKey: HOST_KEY_A,
    });
    const seenLongAgo = await repo.register({
      userId: owner.userId,
      name: "Seen long ago",
      platform: "macos",
      hostKey: HOST_KEY_A,
    });
    const revoked = await repo.register({
      userId: owner.userId,
      name: "Revoked",
      platform: "macos",
      hostKey: HOST_KEY_A,
    });
    await repo.register({ userId: stranger.userId, name: "Theirs", platform: "macos", hostKey: HOST_KEY_A });
    await repo.recordStatusChange(seenRecently.bridgeId, owner.userId, "inactive", new Date("2026-10-02T10:00:00Z"));
    await repo.recordStatusChange(seenLongAgo.bridgeId, owner.userId, "active", new Date("2026-10-01T10:00:00Z"));
    await repo.recordStatusChange(revoked.bridgeId, owner.userId, "active", new Date("2026-10-03T10:00:00Z"));
    await repo.revoke(revoked.bridgeId, owner.userId, new Date());
    const update = { name: "Reinstalled", platform: "linux", hostKey: HOST_KEY_A };

    const matched = await repo.updateByHostKeyForUser({ hostKey: HOST_KEY_A, userId: owner.userId, update });
    const noMatch = await repo.updateByHostKeyForUser({ hostKey: HOST_KEY_B, userId: owner.userId, update });

    assert.equal(matched?.bridgeId, seenRecently.bridgeId);
    assert.equal(matched?.name, "Reinstalled");
    assert.equal(matched?.platform, "linux");
    assert.equal((await repo.findById(seenLongAgo.bridgeId))?.name, "Seen long ago");
    assert.equal(noMatch, null);
  });

  it("recordStatusChange updates status and lastSeenAt", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Bridge", platform: "macos" });
    const at = new Date("2026-06-08T10:00:00Z");

    const updatedResult = await repo.recordStatusChange(bridge.bridgeId, user.userId, "active", at);
    const updated = await repo.findById(bridge.bridgeId);
    assert.deepEqual(updatedResult, {
      found: true,
      updated: true,
      statusChanged: true,
      name: "Bridge",
      nickname: null,
    });
    assert.equal(updated?.status, "active");
    assert.equal(updated?.lastSeenAt?.toISOString(), at.toISOString());
  });

  it("recordStatusChange updates lastSeenAt without reporting statusChanged for heartbeats", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Bridge", platform: "macos" });
    await repo.recordStatusChange(bridge.bridgeId, user.userId, "active", new Date("2026-06-08T10:00:00Z"));
    const heartbeatAt = new Date("2026-06-08T10:01:00Z");

    const heartbeatResult = await repo.recordStatusChange(bridge.bridgeId, user.userId, "active", heartbeatAt);
    const updated = await repo.findById(bridge.bridgeId);

    assert.deepEqual(heartbeatResult, {
      found: true,
      updated: true,
      statusChanged: false,
      name: "Bridge",
      nickname: null,
    });
    assert.equal(updated?.status, "active");
    assert.equal(updated?.lastSeenAt?.toISOString(), heartbeatAt.toISOString());
  });

  it("recordStatusChange ignores stale (older-timestamp) events", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Bridge", platform: "macos" });
    const firstAt = new Date("2026-06-08T10:00:00Z");
    const staleAt = new Date("2026-06-08T09:59:00Z");

    await repo.recordStatusChange(bridge.bridgeId, user.userId, "active", firstAt);
    const staleResult = await repo.recordStatusChange(bridge.bridgeId, user.userId, "inactive", staleAt);
    const updated = await repo.findById(bridge.bridgeId);

    assert.deepEqual(staleResult, {
      found: true,
      updated: false,
      statusChanged: false,
      name: "Bridge",
      nickname: null,
    });
    assert.equal(updated?.status, "active");
    assert.equal(updated?.lastSeenAt?.toISOString(), firstAt.toISOString());
  });

  it("recordStatusChange applies a status flip carrying a tied timestamp", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Bridge", platform: "macos" });
    const at = new Date("2026-06-08T10:00:00Z");

    await repo.recordStatusChange(bridge.bridgeId, user.userId, "active", at);
    const flipResult = await repo.recordStatusChange(bridge.bridgeId, user.userId, "inactive", at);
    const updated = await repo.findById(bridge.bridgeId);

    assert.deepEqual(flipResult, { found: true, updated: true, statusChanged: true, name: "Bridge", nickname: null });
    assert.equal(updated?.status, "inactive");
    assert.equal(updated?.lastSeenAt?.toISOString(), at.toISOString());
  });

  it("recordStatusChange treats a duplicate identical event as an idempotent no-op", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Bridge", platform: "macos" });
    const at = new Date("2026-06-08T10:00:00Z");

    await repo.recordStatusChange(bridge.bridgeId, user.userId, "active", at);
    const duplicateResult = await repo.recordStatusChange(bridge.bridgeId, user.userId, "active", at);
    const updated = await repo.findById(bridge.bridgeId);

    assert.deepEqual(duplicateResult, {
      found: true,
      updated: true,
      statusChanged: false,
      name: "Bridge",
      nickname: null,
    });
    assert.equal(updated?.status, "active");
    assert.equal(updated?.lastSeenAt?.toISOString(), at.toISOString());
  });

  it("recordStatusChange is owner-scoped and ignores revoked bridges", async () => {
    const owner = await ctx.createUser();
    const stranger = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: owner.userId, name: "Bridge", platform: "macos" });
    const at = new Date("2026-06-08T10:00:00Z");

    const wrongOwnerResult = await repo.recordStatusChange(bridge.bridgeId, stranger.userId, "active", at);
    const afterWrongOwner = await repo.findById(bridge.bridgeId);
    assert.deepEqual(wrongOwnerResult, { found: false });
    assert.equal(afterWrongOwner?.status, "inactive");
    assert.equal(afterWrongOwner?.lastSeenAt, null);

    await repo.revoke(bridge.bridgeId, owner.userId, new Date("2026-06-08T10:01:00Z"));
    const revokedResult = await repo.recordStatusChange(bridge.bridgeId, owner.userId, "active", at);
    const afterRevoked = await repo.findById(bridge.bridgeId);
    assert.deepEqual(revokedResult, { found: false });
    assert.equal(afterRevoked?.status, "inactive");
  });

  it("setNicknameForUser sets and unsets the nickname, which registration updates keep", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "dev-laptop", platform: "macos", hostKey: null });

    const named = await repo.setNicknameForUser({ bridgeId: bridge.bridgeId, userId: user.userId, nickname: "Work" });
    assert.equal(named?.nickname, "Work");
    assert.equal(named?.name, "dev-laptop");

    await repo.updateForUser(bridge.bridgeId, user.userId, { name: "dev-laptop-2", platform: "macos", hostKey: null });
    const status = await repo.recordStatusChange(bridge.bridgeId, user.userId, "active", new Date());
    assert.deepEqual(status, {
      found: true,
      updated: true,
      statusChanged: true,
      name: "dev-laptop-2",
      nickname: "Work",
    });

    const cleared = await repo.setNicknameForUser({ bridgeId: bridge.bridgeId, userId: user.userId, nickname: null });
    assert.ok(cleared && !("nickname" in cleared));
  });

  it("setNicknameForUser returns null for foreign, invalid-owner, or revoked bridges", async () => {
    const owner = await ctx.createUser();
    const stranger = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: owner.userId, name: "Bridge", platform: "macos", hostKey: null });

    for (const userId of [stranger.userId, "not-an-object-id"]) {
      assert.equal(await repo.setNicknameForUser({ bridgeId: bridge.bridgeId, userId, nickname: "X" }), null);
    }
    await repo.revoke(bridge.bridgeId, owner.userId, new Date());
    assert.equal(
      await repo.setNicknameForUser({ bridgeId: bridge.bridgeId, userId: owner.userId, nickname: "X" }),
      null,
    );
    assert.ok(!("nickname" in ((await repo.findById(bridge.bridgeId)) ?? {})));
  });

  it("revoke returns true on first call, false on second (already revoked)", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Bridge", platform: "macos" });

    const first = await repo.revoke(bridge.bridgeId, user.userId, new Date());
    const second = await repo.revoke(bridge.bridgeId, user.userId, new Date());
    assert.equal(first, true);
    assert.equal(second, false);
  });

  it("revoke sets status to inactive", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Bridge", platform: "macos" });
    await repo.recordStatusChange(bridge.bridgeId, user.userId, "active", new Date());

    const result = await repo.revoke(bridge.bridgeId, user.userId, new Date());
    const revoked = await repo.findById(bridge.bridgeId);
    assert.equal(result, true);
    assert.equal(revoked?.status, "inactive");
    assert.ok(revoked?.revokedAt instanceof Date);
  });

  it("revoke is owner-scoped — wrong userId returns false", async () => {
    const owner = await ctx.createUser();
    const stranger = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: owner.userId, name: "Bridge", platform: "macos" });

    const result = await repo.revoke(bridge.bridgeId, stranger.userId, new Date());
    assert.equal(result, false);

    const stillActive = await repo.findById(bridge.bridgeId);
    assert.equal(stillActive?.revokedAt, null);
  });

  it("revoke returns false for invalid userId", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Bridge", platform: "macos" });

    const result = await repo.revoke(bridge.bridgeId, "not-an-object-id", new Date());
    assert.equal(result, false);
  });

  it("revokeAllForUser returns only newly revoked bridges and filters cleanup candidates", async () => {
    const user = await ctx.createUser();
    const otherUser = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const first = await repo.register({ userId: user.userId, name: "First", platform: "macos" });
    const second = await repo.register({ userId: user.userId, name: "Second", platform: "linux" });
    const other = await repo.register({ userId: otherUser.userId, name: "Other", platform: "windows" });
    await repo.revoke(second.bridgeId, user.userId, new Date("2026-06-08T10:00:00Z"));

    assert.deepEqual(
      await repo.findRevokedIdsForUser({
        userId: user.userId,
        bridgeIds: [first.bridgeId, second.bridgeId, other.bridgeId],
      }),
      [second.bridgeId],
    );

    const revoked = await repo.revokeAllForUser(user.userId, new Date("2026-06-08T10:01:00Z"));
    const afterFirst = await repo.findById(first.bridgeId);
    const afterSecond = await repo.findById(second.bridgeId);
    const afterOther = await repo.findById(other.bridgeId);

    assert.deepEqual(
      revoked.map((bridge) => bridge.bridgeId),
      [first.bridgeId],
    );
    assert.deepEqual(
      await repo.findRevokedIdsForUser({
        userId: user.userId,
        bridgeIds: [first.bridgeId, second.bridgeId, other.bridgeId],
      }),
      [first.bridgeId, second.bridgeId].sort(),
    );
    assert.equal(afterFirst?.status, "inactive");
    assert.ok(afterFirst?.revokedAt instanceof Date);
    assert.equal(afterSecond?.revokedAt?.toISOString(), "2026-06-08T10:00:00.000Z");
    assert.equal(afterOther?.revokedAt, null);
  });
});

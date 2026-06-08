import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { BridgeRepository } from "../../src/repositories/bridge-repo.js";

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

  it("register is not an upsert — second call creates a new row", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const first = await repo.register({ userId: user.userId, name: "Same Name", platform: "macos" });
    const second = await repo.register({ userId: user.userId, name: "Same Name", platform: "macos" });

    assert.notEqual(first.bridgeId, second.bridgeId);
    const bridges = await repo.findByUserId(user.userId);
    assert.equal(bridges.length, 2);
  });

  it("recordStatusChange updates status and lastSeenAt", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Bridge", platform: "macos" });
    const at = new Date("2026-06-08T10:00:00Z");

    const updatedResult = await repo.recordStatusChange(bridge.bridgeId, user.userId, "active", at);
    const updated = await repo.findById(bridge.bridgeId);
    assert.deepEqual(updatedResult, { updated: true, statusChanged: true });
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

    assert.deepEqual(heartbeatResult, { updated: true, statusChanged: false });
    assert.equal(updated?.status, "active");
    assert.equal(updated?.lastSeenAt?.toISOString(), heartbeatAt.toISOString());
  });

  it("recordStatusChange ignores stale or duplicate event timestamps", async () => {
    const user = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: user.userId, name: "Bridge", platform: "macos" });
    const firstAt = new Date("2026-06-08T10:00:00Z");
    const staleAt = new Date("2026-06-08T09:59:00Z");

    await repo.recordStatusChange(bridge.bridgeId, user.userId, "active", firstAt);
    const staleResult = await repo.recordStatusChange(bridge.bridgeId, user.userId, "inactive", staleAt);
    const duplicateResult = await repo.recordStatusChange(bridge.bridgeId, user.userId, "inactive", firstAt);
    const updated = await repo.findById(bridge.bridgeId);

    assert.deepEqual(staleResult, { updated: false, statusChanged: false });
    assert.deepEqual(duplicateResult, { updated: false, statusChanged: false });
    assert.equal(updated?.status, "active");
    assert.equal(updated?.lastSeenAt?.toISOString(), firstAt.toISOString());
  });

  it("recordStatusChange is owner-scoped and ignores revoked bridges", async () => {
    const owner = await ctx.createUser();
    const stranger = await ctx.createUser();
    const repo = new BridgeRepository(ctx.dbAccessor);
    const bridge = await repo.register({ userId: owner.userId, name: "Bridge", platform: "macos" });
    const at = new Date("2026-06-08T10:00:00Z");

    const wrongOwnerResult = await repo.recordStatusChange(bridge.bridgeId, stranger.userId, "active", at);
    const afterWrongOwner = await repo.findById(bridge.bridgeId);
    assert.deepEqual(wrongOwnerResult, { updated: false, statusChanged: false });
    assert.equal(afterWrongOwner?.status, "inactive");
    assert.equal(afterWrongOwner?.lastSeenAt, null);

    await repo.revoke(bridge.bridgeId, owner.userId, new Date("2026-06-08T10:01:00Z"));
    const revokedResult = await repo.recordStatusChange(bridge.bridgeId, owner.userId, "active", at);
    const afterRevoked = await repo.findById(bridge.bridgeId);
    assert.deepEqual(revokedResult, { updated: false, statusChanged: false });
    assert.equal(afterRevoked?.status, "inactive");
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
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OptionalEmailActivationSnapshotService } from "../../src/services/optional-email-activation-snapshot-service.js";

describe("OptionalEmailActivationSnapshotService", () => {
  it("returns null for a missing current user without reading milestone sources", async () => {
    let milestoneReads = 0;
    const service = new OptionalEmailActivationSnapshotService({
      users: {
        findById: async ({ userId }: { userId: string }) => {
          assert.equal(userId, "000000000000000000000001");
          return null;
        },
      },
      activationStates: {
        findByUserId: async () => {
          milestoneReads += 1;
          return null;
        },
      },
      bridges: {
        findEarliestAddedAt: async () => {
          milestoneReads += 1;
          return null;
        },
      },
      dailyUsage: {
        findEarliestMetadataRequestAt: async () => {
          milestoneReads += 1;
          return null;
        },
      },
    });

    assert.equal(await service.findByUserId({ userId: "000000000000000000000001" }), null);
    assert.equal(milestoneReads, 0);
  });

  it("returns an empty snapshot for an existing user without milestone evidence", async () => {
    const userId = "000000000000000000000002";
    const sourceReads: string[] = [];
    const service = new OptionalEmailActivationSnapshotService({
      users: { findById: async () => ({ createdAt: new Date("2026-09-01T00:00:00.000Z") }) },
      activationStates: {
        findByUserId: async ({ userId: actualUserId }: { userId: string }) => {
          assert.equal(actualUserId, userId);
          sourceReads.push("state");
          return null;
        },
      },
      bridges: {
        findEarliestAddedAt: async ({ userId: actualUserId }: { userId: string }) => {
          assert.equal(actualUserId, userId);
          sourceReads.push("bridge");
          return null;
        },
      },
      dailyUsage: {
        findEarliestMetadataRequestAt: async ({ userId: actualUserId }: { userId: string }) => {
          assert.equal(actualUserId, userId);
          sourceReads.push("session");
          return null;
        },
      },
    });

    assert.deepEqual(await service.findByUserId({ userId }), {
      bridgeSetupAt: null,
      firstSessionAt: null,
    });
    assert.deepEqual(sourceReads.sort(), ["bridge", "session", "state"]);
  });

  it("prefers canonical non-null milestone timestamps", async () => {
    const canonicalBridgeAt = new Date("2026-09-02T10:00:00.000Z");
    const canonicalSessionAt = new Date("2026-09-03T11:00:00.000Z");
    const service = new OptionalEmailActivationSnapshotService({
      users: { findById: async () => ({ createdAt: new Date("2026-09-01T00:00:00.000Z") }) },
      activationStates: {
        findByUserId: async () => ({
          bridgeSetupAt: canonicalBridgeAt,
          firstSessionAt: canonicalSessionAt,
        }),
      },
      bridges: { findEarliestAddedAt: async () => new Date("2026-09-04T00:00:00.000Z") },
      dailyUsage: { findEarliestMetadataRequestAt: async () => new Date("2026-09-05T00:00:00.000Z") },
    });

    assert.deepEqual(await service.findByUserId({ userId: "000000000000000000000003" }), {
      bridgeSetupAt: canonicalBridgeAt,
      firstSessionAt: canonicalSessionAt,
    });
  });

  it("fills missing canonical milestones from current-account authoritative evidence", async () => {
    const accountCreatedAt = new Date("2026-09-01T00:00:00.000Z");
    const sessionAt = new Date("2026-09-02T12:00:00.000Z");
    const service = new OptionalEmailActivationSnapshotService({
      users: { findById: async () => ({ createdAt: accountCreatedAt }) },
      activationStates: {
        findByUserId: async () => ({ bridgeSetupAt: null, firstSessionAt: null }),
      },
      bridges: { findEarliestAddedAt: async () => accountCreatedAt },
      dailyUsage: { findEarliestMetadataRequestAt: async () => sessionAt },
    });

    assert.deepEqual(await service.findByUserId({ userId: "000000000000000000000004" }), {
      bridgeSetupAt: accountCreatedAt,
      firstSessionAt: sessionAt,
    });
  });

  it("discards authoritative evidence that predates the current account", async () => {
    const service = new OptionalEmailActivationSnapshotService({
      users: { findById: async () => ({ createdAt: new Date("2026-09-01T00:00:00.000Z") }) },
      activationStates: { findByUserId: async () => null },
      bridges: { findEarliestAddedAt: async () => new Date("2026-08-30T00:00:00.000Z") },
      dailyUsage: { findEarliestMetadataRequestAt: async () => new Date("2026-08-31T23:59:59.999Z") },
    });

    assert.deepEqual(await service.findByUserId({ userId: "000000000000000000000005" }), {
      bridgeSetupAt: null,
      firstSessionAt: null,
    });
  });
});

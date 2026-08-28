import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BridgeRepository } from "../../src/repositories/bridge-repo.js";
import type { GlossaryEntryRepository } from "../../src/repositories/glossary-entry-repo.js";
import { BridgeService } from "../../src/services/bridge-service.js";
import type { BridgeStateTracker } from "../../src/services/bridge-state-tracker.js";

function createService(args: { bridgeRepo: object; glossaryRepo: object; bridgeStateTracker: object }): BridgeService {
  return new BridgeService({
    bridgeRepo: args.bridgeRepo as unknown as BridgeRepository,
    glossaryRepo: args.glossaryRepo as unknown as GlossaryEntryRepository,
    bridgeStateTracker: args.bridgeStateTracker as unknown as BridgeStateTracker,
  });
}

describe("BridgeService glossary cleanup", () => {
  it("cancels an individually revoked bridge timer before cleanup can fail", async () => {
    const events: string[] = [];
    const service = createService({
      bridgeRepo: {
        revoke: async () => {
          events.push("revoke");
          return true;
        },
      },
      glossaryRepo: {
        deleteByUserAndBridge: async () => {
          events.push("cleanup");
          throw new Error("cleanup failed");
        },
      },
      bridgeStateTracker: {
        cancelPendingForBridge: () => events.push("cancel"),
      },
    });

    await assert.rejects(() => service.revokeForUser("user", "br_bridge0001"), /cleanup failed/);
    assert.deepEqual(events, ["revoke", "cancel", "cleanup"]);
  });

  it("cancels new timers, filters bounded glossary owners, and bulk deletes only revoked rows", async () => {
    const events: string[] = [];
    const service = createService({
      bridgeRepo: {
        revokeAllForUser: async () => [{ bridgeId: "br_bridge0001" }, { bridgeId: "br_bridge0002" }],
        findRevokedIdsForUser: async (args: { bridgeIds: string[] }) => {
          events.push(`filter:${args.bridgeIds.join(",")}`);
          return args.bridgeIds.filter((bridgeId) => bridgeId !== "br_concurrent");
        },
      },
      glossaryRepo: {
        findBridgeLocalOwnerIdsByUser: async () => {
          events.push("candidates");
          return ["br_bridge0001", "br_bridge0002", "br_concurrent"];
        },
        deleteByUserAndBridges: async (args: { bridgeIds: string[] }) => {
          events.push(`cleanup:${args.bridgeIds.join(",")}`);
          return 2;
        },
      },
      bridgeStateTracker: {
        cancelPendingForBridge: (_userId: string, bridgeId: string) => events.push(`cancel:${bridgeId}`),
      },
    });

    await service.revokeAllForUser("user");

    assert.deepEqual(events, [
      "cancel:br_bridge0001",
      "cancel:br_bridge0002",
      "candidates",
      "filter:br_bridge0001,br_bridge0002,br_concurrent",
      "cleanup:br_bridge0001,br_bridge0002",
    ]);
  });
});

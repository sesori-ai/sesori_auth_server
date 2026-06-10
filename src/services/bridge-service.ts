import type { Bridge as BridgeDoc } from "../models/documents.js";
import type { BridgePlatform, BridgeSummary } from "../models/api.js";
import type { BridgeStatus } from "../models/bridge.js";
import type { BridgeRepository } from "../repositories/bridge-repo.js";
import type { BridgeStateTracker } from "./bridge-state-tracker.js";

function toSummary(bridge: BridgeDoc): BridgeSummary {
  return {
    id: bridge.bridgeId,
    name: bridge.name,
    addedAt: bridge.addedAt.toISOString(),
    lastSeenAt: bridge.lastSeenAt ? bridge.lastSeenAt.toISOString() : null,
    platform: bridge.platform,
  };
}

export type RegisterBridgeResult = {
  bridge: BridgeSummary;
  created: boolean;
};

export class BridgeService {
  readonly #bridgeRepo: BridgeRepository;
  readonly #bridgeStateTracker: BridgeStateTracker;

  constructor(deps: { bridgeRepo: BridgeRepository; bridgeStateTracker: BridgeStateTracker }) {
    this.#bridgeRepo = deps.bridgeRepo;
    this.#bridgeStateTracker = deps.bridgeStateTracker;
  }

  // Idempotent registration: a bridgeId that identifies a non-revoked bridge
  // owned by this user updates it in place; anything else (absent, unknown,
  // revoked, or another user's bridgeId) silently mints a new bridge.
  async registerForUser(
    userId: string,
    input: { name: string; platform: BridgePlatform; bridgeId?: string },
  ): Promise<RegisterBridgeResult> {
    if (input.bridgeId) {
      const updated = await this.#bridgeRepo.updateForUser(input.bridgeId, userId, {
        name: input.name,
        platform: input.platform,
      });
      if (updated) {
        return { bridge: toSummary(updated), created: false };
      }
    }

    const bridge = await this.#bridgeRepo.register({ userId, name: input.name, platform: input.platform });
    return { bridge: toSummary(bridge), created: true };
  }

  async listForUser(userId: string): Promise<BridgeSummary[]> {
    const bridges = await this.#bridgeRepo.findByUserId(userId);
    return bridges.map(toSummary);
  }

  async revokeForUser(userId: string, bridgeId: string): Promise<boolean> {
    const revoked = await this.#bridgeRepo.revoke(bridgeId, userId, new Date());
    if (revoked) {
      this.#bridgeStateTracker.cancelPendingForBridge(userId, bridgeId);
      const remainingBridges = await this.#bridgeRepo.findByUserId(userId);
      if (remainingBridges.length === 0) {
        this.#bridgeStateTracker.cancelPendingForUser(userId);
      }
    }
    return revoked;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const bridges = await this.#bridgeRepo.revokeAllForUser(userId, new Date());
    this.#bridgeStateTracker.cancelPendingForUser(userId);
    for (const bridge of bridges) {
      this.#bridgeStateTracker.cancelPendingForBridge(userId, bridge.bridgeId);
    }
  }

  async findByIdForUser(bridgeId: string, userId: string): Promise<BridgeDoc | null> {
    return this.#bridgeRepo.findByIdForUser(bridgeId, userId);
  }

  async recordStatusChange(bridgeId: string, userId: string, status: BridgeStatus, at: Date): Promise<void> {
    const result = await this.#bridgeRepo.recordStatusChange(bridgeId, userId, status, at);
    if (!result.updated) {
      return;
    }

    this.#bridgeStateTracker.cancelPendingForUser(userId);
    if (result.statusChanged) {
      this.#bridgeStateTracker.handleStatusChangeForBridge(userId, bridgeId, status);
    }
  }
}

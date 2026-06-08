import type { Bridge as BridgeDoc } from "../models/documents.js";
import type { BridgePlatform, BridgeSummary } from "../models/api.js";
import type { BridgeRepository } from "../repositories/bridge-repo.js";
import type { BridgeStateTracker } from "./bridge-state-tracker.js";

function toSummary(bridge: BridgeDoc): BridgeSummary {
  return {
    id: bridge.bridgeId,
    name: bridge.name,
    status: bridge.status,
    addedAt: bridge.addedAt.toISOString(),
    lastSeenAt: bridge.lastSeenAt ? bridge.lastSeenAt.toISOString() : null,
    platform: bridge.platform,
  };
}

export class BridgeService {
  readonly #bridgeRepo: BridgeRepository;
  readonly #bridgeStateTracker: BridgeStateTracker;

  constructor(deps: { bridgeRepo: BridgeRepository; bridgeStateTracker: BridgeStateTracker }) {
    this.#bridgeRepo = deps.bridgeRepo;
    this.#bridgeStateTracker = deps.bridgeStateTracker;
  }

  async registerForUser(userId: string, name: string, platform: BridgePlatform): Promise<BridgeSummary> {
    const bridge = await this.#bridgeRepo.register({ userId, name, platform });
    return toSummary(bridge);
  }

  async listForUser(userId: string): Promise<BridgeSummary[]> {
    const bridges = await this.#bridgeRepo.findByUserId(userId);
    return bridges.map(toSummary);
  }

  async revokeForUser(userId: string, bridgeId: string): Promise<boolean> {
    const revoked = await this.#bridgeRepo.revoke(bridgeId, userId, new Date());
    if (revoked) {
      this.#bridgeStateTracker.cancelPendingForBridge(userId, bridgeId);
    }
    return revoked;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const bridges = await this.#bridgeRepo.revokeAllForUser(userId, new Date());
    for (const bridge of bridges) {
      this.#bridgeStateTracker.cancelPendingForBridge(userId, bridge.bridgeId);
    }
  }

  async findByIdForUser(bridgeId: string, userId: string): Promise<BridgeDoc | null> {
    return this.#bridgeRepo.findByIdForUser(bridgeId, userId);
  }

  async recordStatusChange(bridgeId: string, userId: string, status: "active" | "inactive", at: Date): Promise<void> {
    const result = await this.#bridgeRepo.recordStatusChange(bridgeId, userId, status, at);
    if (result.updated && result.statusChanged) {
      this.#bridgeStateTracker.handleStatusChangeForBridge(userId, bridgeId, status);
    }
  }
}

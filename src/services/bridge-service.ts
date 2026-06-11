import { BadRequestError } from "../lib/errors.js";
import type { Bridge as BridgeDoc } from "../models/documents.js";
import type { BridgePlatform, BridgeSummary } from "../models/api.js";
import type { BridgeStatus } from "../models/bridge.js";
import type { BridgeRepository } from "../repositories/bridge-repo.js";
import type { BridgeStateTracker } from "./bridge-state-tracker.js";

// Upper bound on non-revoked bridges per user. Registration is idempotent
// (clients resend their bridgeId), so legitimate users stay far below this;
// the cap exists so /auth/me's bridges[] payload cannot grow unboundedly.
const MAX_ACTIVE_BRIDGES_PER_USER = 50;

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

    const existing = await this.#bridgeRepo.findByUserId(userId);
    if (existing.length >= MAX_ACTIVE_BRIDGES_PER_USER) {
      throw new BadRequestError({ debugMessage: "Too many registered bridges" });
    }

    const bridge = await this.#bridgeRepo.register({ userId, name: input.name, platform: input.platform });

    // The pre-insert count above is racy (no DB-level constraint backs the
    // cap), so concurrent registrations could overshoot it. Re-count after
    // the insert and self-revoke the overflow: the cap bounds /auth/me's
    // bridges[] payload and must hold under parallel bursts too.
    const after = await this.#bridgeRepo.findByUserId(userId);
    if (after.length > MAX_ACTIVE_BRIDGES_PER_USER) {
      await this.#bridgeRepo.revoke(bridge.bridgeId, userId, new Date());
      throw new BadRequestError({ debugMessage: "Too many registered bridges" });
    }

    return { bridge: toSummary(bridge), created: true };
  }

  async listForUser(userId: string): Promise<BridgeSummary[]> {
    const bridges = await this.#bridgeRepo.findByUserId(userId);
    return bridges.map(toSummary);
  }

  // Only the bridge's own per-instance timer is cancelled here. The legacy
  // (user-level) timer tracks bridges that never registered — old clients
  // reporting without a bridgeId — so the count of registered bridges says
  // nothing about whether it is still needed. Account-level cleanup happens
  // in revokeAllForUser.
  async revokeForUser(userId: string, bridgeId: string): Promise<boolean> {
    const revoked = await this.#bridgeRepo.revoke(bridgeId, userId, new Date());
    if (revoked) {
      this.#bridgeStateTracker.cancelPendingForBridge(userId, bridgeId);
    }
    return revoked;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const bridges = await this.#bridgeRepo.revokeAllForUser(userId, new Date());
    // The user-level cancel only clears the legacy key; per-bridge timers
    // live under distinct (userId, bridgeId) keys and need individual cancels.
    this.#bridgeStateTracker.cancelPendingForUser(userId);
    for (const bridge of bridges) {
      this.#bridgeStateTracker.cancelPendingForBridge(userId, bridge.bridgeId);
    }
  }

  // Atomically records a relay-reported status event. found=false means the
  // bridge is unknown, revoked, or another user's — the route turns that into
  // the 404 the relay converts to WS close 4006. A stale (out-of-order) event
  // on a live bridge reports found=true and is dropped silently: surfacing it
  // as 404 would make the relay close a live bridge over event reordering.
  async recordStatusChange(
    bridgeId: string,
    userId: string,
    status: BridgeStatus,
    at: Date,
  ): Promise<{ found: boolean }> {
    const result = await this.#bridgeRepo.recordStatusChange(bridgeId, userId, status, at);
    if (!result.found || !result.updated) {
      return { found: result.found };
    }

    this.#bridgeStateTracker.cancelPendingForUser(userId);
    if (result.statusChanged) {
      this.#bridgeStateTracker.handleStatusChangeForBridge(userId, bridgeId, status);
    }
    return { found: true };
  }
}

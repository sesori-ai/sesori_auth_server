import type { ActivationState } from "../models/documents.js";
import type { ActivationMilestoneUpdate, ActivationStateRepository } from "../repositories/activation-state-repo.js";
import type { BridgeRepository } from "../repositories/bridge-repo.js";
import type { DailyUsageRepository } from "../repositories/daily-usage-repo.js";
import type { DeviceTokenRepository } from "../repositories/device-token-repo.js";
import type { UserRepository } from "../repositories/user-repo.js";

export class ActivationService {
  readonly #activationStateRepo: ActivationStateRepository;
  readonly #bridgeRepo: BridgeRepository;
  readonly #dailyUsageRepo: DailyUsageRepository;
  readonly #deviceTokenRepo: DeviceTokenRepository;
  readonly #userRepo: UserRepository;

  constructor(deps: {
    activationStateRepo: ActivationStateRepository;
    bridgeRepo: BridgeRepository;
    dailyUsageRepo: DailyUsageRepository;
    deviceTokenRepo: DeviceTokenRepository;
    userRepo: UserRepository;
  }) {
    this.#activationStateRepo = deps.activationStateRepo;
    this.#bridgeRepo = deps.bridgeRepo;
    this.#dailyUsageRepo = deps.dailyUsageRepo;
    this.#deviceTokenRepo = deps.deviceTokenRepo;
    this.#userRepo = deps.userRepo;
  }

  async #recordReconciledMilestones(
    userId: string,
    observedMilestone: keyof ActivationMilestoneUpdate,
    observedAt: Date,
  ): Promise<ActivationState> {
    const existing = await this.#activationStateRepo.findByUserId(userId);
    const [user, rawMobileSetupAt, rawBridgeSetupAt, rawFirstSessionAt] = await Promise.all([
      this.#userRepo.findById(userId),
      existing?.mobileSetupAt ? null : this.#deviceTokenRepo.findEarliestCreatedAt(userId),
      existing?.bridgeSetupAt ? null : this.#bridgeRepo.findEarliestAddedAt(userId),
      existing?.firstSessionAt ? null : this.#dailyUsageRepo.findEarliestMetadataRequestAt(userId),
    ]);
    // Device-token rows survive account re-registration with their original
    // createdAt, so reconciled evidence can predate this account's creation.
    // Such evidence is not a milestone of this account: ignore it and let the
    // directly observed occurrence (which is genuinely current) stand instead.
    const accountCreatedAt = user?.createdAt ?? null;
    const guard = (kind: string, evidenceAt: Date | null): Date | null => {
      if (evidenceAt && accountCreatedAt && evidenceAt < accountCreatedAt) {
        console.warn("[ActivationService] Ignored milestone evidence predating account creation", {
          userId,
          milestone: kind,
        });
        return null;
      }
      return evidenceAt;
    };
    const mobileSetupAt = guard("mobile_setup", rawMobileSetupAt);
    const bridgeSetupAt = guard("bridge_setup", rawBridgeSetupAt);
    const firstSessionAt = guard("first_session", rawFirstSessionAt);
    const update: ActivationMilestoneUpdate = {
      mobileSetupAt: existing?.mobileSetupAt
        ? undefined
        : (mobileSetupAt ?? (observedMilestone === "mobileSetupAt" ? observedAt : undefined)),
      bridgeSetupAt: existing?.bridgeSetupAt
        ? undefined
        : (bridgeSetupAt ?? (observedMilestone === "bridgeSetupAt" ? observedAt : undefined)),
      firstSessionAt: existing?.firstSessionAt
        ? observedMilestone === "firstSessionAt" && observedAt < existing.firstSessionAt
          ? observedAt
          : undefined
        : (firstSessionAt ?? (observedMilestone === "firstSessionAt" ? observedAt : undefined)),
    };
    if (existing && !update.mobileSetupAt && !update.bridgeSetupAt && !update.firstSessionAt) {
      return existing;
    }

    const { state, recorded } = await this.#activationStateRepo.recordMilestonesWithResult(userId, update, observedAt);
    const milestones = [
      { kind: "mobile_setup", occurredAt: recorded.mobileSetupAt },
      { kind: "bridge_setup", occurredAt: recorded.bridgeSetupAt },
      { kind: "first_session", occurredAt: recorded.firstSessionAt },
    ] as const;
    for (const milestone of milestones) {
      if (milestone.occurredAt) {
        console.log("[ActivationService] Milestone recorded", {
          userId,
          milestone: milestone.kind,
          occurredAt: milestone.occurredAt,
        });
      }
    }
    return state;
  }

  async recordAppSetup(userId: string, observedAt = new Date()): Promise<ActivationState> {
    return this.#recordReconciledMilestones(userId, "mobileSetupAt", observedAt);
  }

  async recordBridgeSetup(userId: string, observedAt = new Date()): Promise<ActivationState> {
    return this.#recordReconciledMilestones(userId, "bridgeSetupAt", observedAt);
  }

  async recordFirstSession(userId: string, observedAt = new Date()): Promise<ActivationState> {
    return this.#recordReconciledMilestones(userId, "firstSessionAt", observedAt);
  }
}

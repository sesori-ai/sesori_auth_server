import { isMobileDevicePlatform, type DevicePlatform } from "../models/device.js";
import type { ActivationState } from "../models/documents.js";
import type { ActivationMilestoneUpdate, ActivationStateRepository } from "../repositories/activation-state-repo.js";
import type { BridgeRepository } from "../repositories/bridge-repo.js";
import type { DailyUsageRepository } from "../repositories/daily-usage-repo.js";
import type { DeviceTokenRepository } from "../repositories/device-token-repo.js";

export class ActivationService {
  readonly #activationStateRepo: ActivationStateRepository;
  readonly #bridgeRepo: BridgeRepository;
  readonly #dailyUsageRepo: DailyUsageRepository;
  readonly #deviceTokenRepo: DeviceTokenRepository;

  constructor(deps: {
    activationStateRepo: ActivationStateRepository;
    bridgeRepo: BridgeRepository;
    dailyUsageRepo: DailyUsageRepository;
    deviceTokenRepo: DeviceTokenRepository;
  }) {
    this.#activationStateRepo = deps.activationStateRepo;
    this.#bridgeRepo = deps.bridgeRepo;
    this.#dailyUsageRepo = deps.dailyUsageRepo;
    this.#deviceTokenRepo = deps.deviceTokenRepo;
  }

  async #recordReconciledMilestones(
    userId: string,
    observedMilestone: keyof ActivationMilestoneUpdate,
    observedAt: Date,
  ): Promise<ActivationState> {
    const existing = await this.#activationStateRepo.findByUserId(userId);
    const [mobileSetupAt, bridgeSetupAt, firstSessionAt] = await Promise.all([
      existing?.mobileSetupAt ? null : this.#deviceTokenRepo.findEarliestMobileCreatedAt(userId),
      existing?.bridgeSetupAt ? null : this.#bridgeRepo.findEarliestAddedAt(userId),
      existing?.firstSessionAt ? null : this.#dailyUsageRepo.findEarliestMetadataRequestAt(userId),
    ]);
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

  async recordDeviceTokenRegistration(
    userId: string,
    platform: DevicePlatform,
    observedAt = new Date(),
  ): Promise<ActivationState | null> {
    if (!isMobileDevicePlatform(platform)) {
      return null;
    }

    return this.#recordReconciledMilestones(userId, "mobileSetupAt", observedAt);
  }

  async recordBridgeSetup(userId: string, observedAt = new Date()): Promise<ActivationState> {
    return this.#recordReconciledMilestones(userId, "bridgeSetupAt", observedAt);
  }

  async recordFirstSession(userId: string, observedAt = new Date()): Promise<ActivationState> {
    return this.#recordReconciledMilestones(userId, "firstSessionAt", observedAt);
  }
}

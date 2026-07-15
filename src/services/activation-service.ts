import type { ActivationState } from "../models/documents.js";
import type { ActivationStateRepository } from "../repositories/activation-state-repo.js";
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

  async recordMobileSetup(userId: string, observedAt = new Date()): Promise<ActivationState> {
    const existing = await this.#activationStateRepo.findByUserId(userId);
    const [mobileSetupAt, bridgeSetupAt, firstSessionAt] = await Promise.all([
      existing?.mobileSetupAt ? null : this.#deviceTokenRepo.findEarliestCreatedAt(userId),
      existing?.bridgeSetupAt ? null : this.#bridgeRepo.findEarliestAddedAt(userId),
      existing?.firstSessionAt ? null : this.#dailyUsageRepo.findEarliestMetadataRequestAt(userId),
    ]);
    const update = {
      mobileSetupAt: existing?.mobileSetupAt ? undefined : (mobileSetupAt ?? observedAt),
      bridgeSetupAt: existing?.bridgeSetupAt ? undefined : (bridgeSetupAt ?? undefined),
      firstSessionAt: existing?.firstSessionAt ? undefined : (firstSessionAt ?? undefined),
    };
    if (existing && !update.mobileSetupAt && !update.bridgeSetupAt && !update.firstSessionAt) {
      return existing;
    }

    return this.#activationStateRepo.recordMilestones(userId, update, observedAt);
  }

  async recordBridgeSetup(userId: string, observedAt = new Date()): Promise<ActivationState> {
    const existing = await this.#activationStateRepo.findByUserId(userId);
    if (existing?.bridgeSetupAt) {
      return existing;
    }
    const historicalAt = await this.#bridgeRepo.findEarliestAddedAt(userId);
    return this.#activationStateRepo.recordMilestones(
      userId,
      { bridgeSetupAt: historicalAt ?? observedAt },
      observedAt,
    );
  }

  async recordFirstSession(userId: string, observedAt = new Date()): Promise<ActivationState> {
    const existing = await this.#activationStateRepo.findByUserId(userId);
    if (existing?.firstSessionAt) {
      return existing;
    }
    const historicalAt = await this.#dailyUsageRepo.findEarliestMetadataRequestAt(userId);
    return this.#activationStateRepo.recordMilestones(
      userId,
      { firstSessionAt: historicalAt ?? observedAt },
      observedAt,
    );
  }
}

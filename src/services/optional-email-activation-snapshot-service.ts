import type { OptionalEmailActivationStateSnapshot } from "./optional-email-eligibility-service.js";

interface OptionalEmailActivationSnapshotUserLookup {
  findById(input: { userId: string }): Promise<{ createdAt: Date } | null>;
}

interface OptionalEmailActivationSnapshotStateLookup {
  findByUserId(input: { userId: string }): Promise<{
    bridgeSetupAt: Date | null;
    firstSessionAt: Date | null;
  } | null>;
}

interface OptionalEmailActivationSnapshotBridgeLookup {
  findEarliestAddedAt(input: { userId: string }): Promise<Date | null>;
}

interface OptionalEmailActivationSnapshotDailyUsageLookup {
  findEarliestMetadataRequestAt(input: { userId: string }): Promise<Date | null>;
}

export class OptionalEmailActivationSnapshotService {
  readonly #users: OptionalEmailActivationSnapshotUserLookup;
  readonly #activationStates: OptionalEmailActivationSnapshotStateLookup;
  readonly #bridges: OptionalEmailActivationSnapshotBridgeLookup;
  readonly #dailyUsage: OptionalEmailActivationSnapshotDailyUsageLookup;

  constructor(input: {
    users: OptionalEmailActivationSnapshotUserLookup;
    activationStates: OptionalEmailActivationSnapshotStateLookup;
    bridges: OptionalEmailActivationSnapshotBridgeLookup;
    dailyUsage: OptionalEmailActivationSnapshotDailyUsageLookup;
  }) {
    this.#users = input.users;
    this.#activationStates = input.activationStates;
    this.#bridges = input.bridges;
    this.#dailyUsage = input.dailyUsage;
  }

  async findByUserId(input: { userId: string }): Promise<OptionalEmailActivationStateSnapshot | null> {
    const user = await this.#users.findById({ userId: input.userId });
    if (!user) {
      return null;
    }

    const state = await this.#activationStates.findByUserId({ userId: input.userId });
    const [bridgeSetupAt, firstSessionAt] = await Promise.all([
      state?.bridgeSetupAt ? null : this.#bridges.findEarliestAddedAt({ userId: input.userId }),
      state?.firstSessionAt ? null : this.#dailyUsage.findEarliestMetadataRequestAt({ userId: input.userId }),
    ]);
    const currentAccountEvidence = (evidenceAt: Date | null): Date | null =>
      evidenceAt && evidenceAt >= user.createdAt ? evidenceAt : null;
    return {
      bridgeSetupAt: state?.bridgeSetupAt ?? currentAccountEvidence(bridgeSetupAt),
      firstSessionAt: state?.firstSessionAt ?? currentAccountEvidence(firstSessionAt),
    };
  }
}

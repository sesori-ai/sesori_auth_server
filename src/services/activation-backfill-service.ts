import { createHash } from "node:crypto";
import type { ActivationState } from "../models/documents.js";
import type { ActivationBackfillInput, ActivationStateRepository } from "../repositories/activation-state-repo.js";
import type { BridgeRepository } from "../repositories/bridge-repo.js";
import type { DailyUsageRepository } from "../repositories/daily-usage-repo.js";
import type { DeviceTokenRepository } from "../repositories/device-token-repo.js";
import type { UserRepository } from "../repositories/user-repo.js";

export enum ActivationBackfillStage {
  MobileIncomplete = "mobile_incomplete",
  BridgeIncomplete = "bridge_incomplete",
  SessionIncomplete = "session_incomplete",
  Activated = "activated",
}

export enum ActivationBackfillReminder {
  Bridge1 = "bridge_1",
  Bridge2 = "bridge_2",
  Session = "session",
  None = "none",
}

export enum ActivationBackfillMode {
  DryRun = "dry-run",
  Apply = "apply",
}

export type ActivationBackfillCounters = {
  proposed: number;
  applied: number;
};

export type ActivationBackfillReport = {
  mode: ActivationBackfillMode;
  backfillAt: Date;
  batchLimit: number;
  jitterWindowMs: number;
  usersScanned: number;
  usersProposed: number;
  usersApplied: number;
  usersAlreadyBackfilled: number;
  usersFailed: number;
  byStage: Record<ActivationBackfillStage, ActivationBackfillCounters>;
  byReminder: Record<ActivationBackfillReminder, ActivationBackfillCounters>;
};

export type ActivationBackfillOptions = {
  apply: boolean;
  backfillAt: Date;
  batchLimit: number;
  jitterWindowMs: number;
  onBatchComplete?: (report: Readonly<ActivationBackfillReport>) => void;
};

type ActivationEvidence = {
  mobileSetupAt: Date | null;
  bridgeSetupAt: Date | null;
  firstSessionAt: Date | null;
};

type ActivationSnapshot = ActivationEvidence & {
  bridgeReminder1SentAt: Date | null;
  bridgeReminder2SentAt: Date | null;
  sessionReminderSentAt: Date | null;
};

function emptyStageCounters(): Record<ActivationBackfillStage, ActivationBackfillCounters> {
  return {
    [ActivationBackfillStage.MobileIncomplete]: { proposed: 0, applied: 0 },
    [ActivationBackfillStage.BridgeIncomplete]: { proposed: 0, applied: 0 },
    [ActivationBackfillStage.SessionIncomplete]: { proposed: 0, applied: 0 },
    [ActivationBackfillStage.Activated]: { proposed: 0, applied: 0 },
  };
}

function emptyReminderCounters(): Record<ActivationBackfillReminder, ActivationBackfillCounters> {
  return {
    [ActivationBackfillReminder.Bridge1]: { proposed: 0, applied: 0 },
    [ActivationBackfillReminder.Bridge2]: { proposed: 0, applied: 0 },
    [ActivationBackfillReminder.Session]: { proposed: 0, applied: 0 },
    [ActivationBackfillReminder.None]: { proposed: 0, applied: 0 },
  };
}

function snapshotFrom(state: ActivationState | null, evidence: ActivationEvidence): ActivationSnapshot {
  return {
    mobileSetupAt: state?.mobileSetupAt ?? evidence.mobileSetupAt,
    bridgeSetupAt: state?.bridgeSetupAt ?? evidence.bridgeSetupAt,
    firstSessionAt: state?.firstSessionAt ?? evidence.firstSessionAt,
    bridgeReminder1SentAt: state?.bridgeReminder1SentAt ?? null,
    bridgeReminder2SentAt: state?.bridgeReminder2SentAt ?? null,
    sessionReminderSentAt: state?.sessionReminderSentAt ?? null,
  };
}

function stageFor(snapshot: ActivationSnapshot): ActivationBackfillStage {
  if (!snapshot.mobileSetupAt) {
    return ActivationBackfillStage.MobileIncomplete;
  }

  if (!snapshot.bridgeSetupAt) {
    return ActivationBackfillStage.BridgeIncomplete;
  }

  if (!snapshot.firstSessionAt) {
    return ActivationBackfillStage.SessionIncomplete;
  }

  return ActivationBackfillStage.Activated;
}

function reminderFor(snapshot: ActivationSnapshot, pushReachable: boolean): ActivationBackfillReminder {
  if (!pushReachable) {
    return ActivationBackfillReminder.None;
  }

  if (!snapshot.bridgeSetupAt) {
    if (snapshot.bridgeReminder2SentAt) {
      return ActivationBackfillReminder.None;
    }

    return snapshot.bridgeReminder1SentAt ? ActivationBackfillReminder.Bridge2 : ActivationBackfillReminder.Bridge1;
  }

  if (!snapshot.firstSessionAt && !snapshot.sessionReminderSentAt) {
    return ActivationBackfillReminder.Session;
  }

  return ActivationBackfillReminder.None;
}

function sameTime(left: Date | null, right: Date | null): boolean {
  return left !== null && right !== null && left.getTime() === right.getTime();
}

export function deterministicActivationJitterMs(userId: string, jitterWindowMs: number): number {
  if (!Number.isSafeInteger(jitterWindowMs) || jitterWindowMs < 0) {
    throw new RangeError("jitterWindowMs must be a non-negative safe integer");
  }

  if (jitterWindowMs === 0) {
    return 0;
  }

  const hash = createHash("sha256").update(`activation-backfill:${userId}`).digest();
  return Number(hash.readBigUInt64BE(0) % BigInt(jitterWindowMs));
}

export class ActivationBackfillService {
  readonly #userRepo: UserRepository;
  readonly #activationStateRepo: ActivationStateRepository;
  readonly #bridgeRepo: BridgeRepository;
  readonly #dailyUsageRepo: DailyUsageRepository;
  readonly #deviceTokenRepo: DeviceTokenRepository;

  constructor(deps: {
    userRepo: UserRepository;
    activationStateRepo: ActivationStateRepository;
    bridgeRepo: BridgeRepository;
    dailyUsageRepo: DailyUsageRepository;
    deviceTokenRepo: DeviceTokenRepository;
  }) {
    this.#userRepo = deps.userRepo;
    this.#activationStateRepo = deps.activationStateRepo;
    this.#bridgeRepo = deps.bridgeRepo;
    this.#dailyUsageRepo = deps.dailyUsageRepo;
    this.#deviceTokenRepo = deps.deviceTokenRepo;
  }

  async run(options: ActivationBackfillOptions): Promise<ActivationBackfillReport> {
    if (Number.isNaN(options.backfillAt.getTime())) {
      throw new RangeError("backfillAt must be a valid date");
    }

    if (!Number.isSafeInteger(options.batchLimit) || options.batchLimit < 1) {
      throw new RangeError("batchLimit must be a positive safe integer");
    }
    deterministicActivationJitterMs("validation", options.jitterWindowMs);

    const report: ActivationBackfillReport = {
      mode: options.apply ? ActivationBackfillMode.Apply : ActivationBackfillMode.DryRun,
      backfillAt: options.backfillAt,
      batchLimit: options.batchLimit,
      jitterWindowMs: options.jitterWindowMs,
      usersScanned: 0,
      usersProposed: 0,
      usersApplied: 0,
      usersAlreadyBackfilled: 0,
      usersFailed: 0,
      byStage: emptyStageCounters(),
      byReminder: emptyReminderCounters(),
    };

    let afterUserId: string | null = null;
    while (true) {
      const userIds = await this.#userRepo.findIdBatch(afterUserId, options.batchLimit, options.backfillAt);
      if (userIds.length === 0) {
        break;
      }

      for (const userId of userIds) {
        report.usersScanned += 1;
        try {
          await this.#processUser(userId, options, report);
        } catch (error) {
          report.usersFailed += 1;
          console.warn("[ActivationBackfillService] User backfill failed", { userId, error });
        }
      }

      afterUserId = userIds[userIds.length - 1];
      options.onBatchComplete?.(report);
      if (userIds.length < options.batchLimit) {
        break;
      }
    }

    return report;
  }

  async #processUser(
    userId: string,
    options: ActivationBackfillOptions,
    report: ActivationBackfillReport,
  ): Promise<void> {
    const existing = await this.#activationStateRepo.findByUserId(userId);
    if (existing?.backfilledAt) {
      report.usersAlreadyBackfilled += 1;
      return;
    }

    const [mobileSetupAt, bridgeSetupAt, firstSessionAt] = await Promise.all([
      this.#deviceTokenRepo.findEarliestMobileCreatedAt(userId),
      this.#bridgeRepo.findEarliestAddedAt(userId),
      this.#dailyUsageRepo.findEarliestMetadataRequestAt(userId),
    ]);
    const evidence: ActivationEvidence = { mobileSetupAt, bridgeSetupAt, firstSessionAt };
    const snapshot = snapshotFrom(existing, evidence);
    const stage = stageFor(snapshot);
    const reminder = reminderFor(snapshot, mobileSetupAt !== null);
    const jitterMs = deterministicActivationJitterMs(userId, options.jitterWindowMs);
    const baselineAt = new Date(options.backfillAt.getTime() + jitterMs);
    if (Number.isNaN(baselineAt.getTime())) {
      throw new RangeError("Backfill baseline is outside the Date range");
    }

    report.usersProposed += 1;
    report.byStage[stage].proposed += 1;
    report.byReminder[reminder].proposed += 1;
    if (!options.apply) {
      return;
    }

    const input: ActivationBackfillInput = {
      ...evidence,
      // The repository selects the current unsent stage atomically. Supplying
      // one candidate also covers an organic stage transition during this run.
      reminderBaseAt: mobileSetupAt === null ? null : baselineAt,
      backfilledAt: options.backfillAt,
    };
    const applied = await this.#activationStateRepo.applyBackfill(userId, input);
    if (!applied.applied) {
      report.usersAlreadyBackfilled += 1;
      return;
    }

    report.usersApplied += 1;
    const appliedStage = stageFor(snapshotFrom(applied.state, evidence));
    let appliedReminder = ActivationBackfillReminder.None;
    if (
      applied.state.bridgeSetupAt === null &&
      applied.state.bridgeReminder2SentAt === null &&
      sameTime(applied.state.bridgeReminderBaseAt, input.reminderBaseAt)
    ) {
      appliedReminder = applied.state.bridgeReminder1SentAt
        ? ActivationBackfillReminder.Bridge2
        : ActivationBackfillReminder.Bridge1;
    } else if (
      applied.state.bridgeSetupAt !== null &&
      applied.state.firstSessionAt === null &&
      applied.state.sessionReminderSentAt === null &&
      sameTime(applied.state.sessionReminderBaseAt, input.reminderBaseAt)
    ) {
      appliedReminder = ActivationBackfillReminder.Session;
    }
    report.byStage[appliedStage].applied += 1;
    report.byReminder[appliedReminder].applied += 1;
  }
}

import type { ActivationState } from "../models/documents.js";
import type { OptionalEmailEligibilityResult } from "./optional-email-eligibility-service.js";
import type { OptionalEmailRecipientBasis } from "../types/optional-email.js";
import { OptionalEmailReminderKind } from "../types/optional-email.js";

interface OptionalEmailDryRunUserLookup {
  findIdBatch(afterUserId: string | null, batchLimit: number, createdAtOrBefore: Date): Promise<string[]>;
}

interface OptionalEmailDryRunActivationLookup {
  findByUserId(userId: string): Promise<ActivationState | null>;
}

interface OptionalEmailDryRunEligibility {
  evaluateDryRun(input: {
    userId: string;
    reminderKind: OptionalEmailReminderKind;
  }): Promise<OptionalEmailEligibilityResult>;
}

export type OptionalEmailDryRunReport = {
  mode: "dry_run";
  generatedAt: string;
  sendingEnabled: boolean;
  recipientBasis: OptionalEmailRecipientBasis;
  dailyCap: number;
  usersScanned: number;
  candidates: number;
  segments: Record<OptionalEmailReminderKind, number>;
  eligible: number;
  blockedByReason: Record<string, number>;
};

export class OptionalEmailDryRunService {
  readonly #users: OptionalEmailDryRunUserLookup;
  readonly #activationStates: OptionalEmailDryRunActivationLookup;
  readonly #eligibility: OptionalEmailDryRunEligibility;
  readonly #policy: {
    sendingEnabled: boolean;
    recipientBasis: OptionalEmailRecipientBasis;
    dailyCap: number;
  };
  readonly #clock: () => Date;

  constructor(input: {
    users: OptionalEmailDryRunUserLookup;
    activationStates: OptionalEmailDryRunActivationLookup;
    eligibility: OptionalEmailDryRunEligibility;
    policy: {
      sendingEnabled: boolean;
      recipientBasis: OptionalEmailRecipientBasis;
      dailyCap: number;
    };
    clock?: () => Date;
  }) {
    this.#users = input.users;
    this.#activationStates = input.activationStates;
    this.#eligibility = input.eligibility;
    this.#policy = input.policy;
    this.#clock = input.clock ?? (() => new Date());
  }

  async run(input: { batchLimit: number }): Promise<OptionalEmailDryRunReport> {
    if (!Number.isSafeInteger(input.batchLimit) || input.batchLimit < 1 || input.batchLimit > 1_000) {
      throw new Error("InvalidOptionalEmailDryRunBatchLimit");
    }
    const generatedAt = this.#clock();
    const report: OptionalEmailDryRunReport = {
      mode: "dry_run",
      generatedAt: generatedAt.toISOString(),
      sendingEnabled: this.#policy.sendingEnabled,
      recipientBasis: this.#policy.recipientBasis,
      dailyCap: this.#policy.dailyCap,
      usersScanned: 0,
      candidates: 0,
      segments: {
        [OptionalEmailReminderKind.BridgeSetup]: 0,
        [OptionalEmailReminderKind.FirstSession]: 0,
      },
      eligible: 0,
      blockedByReason: {},
    };

    let afterUserId: string | null = null;
    while (true) {
      const userIds = await this.#users.findIdBatch(afterUserId, input.batchLimit, generatedAt);
      if (userIds.length === 0) {
        break;
      }
      for (const userId of userIds) {
        report.usersScanned += 1;
        const state = await this.#activationStates.findByUserId(userId);
        if (state?.firstSessionAt) {
          continue;
        }
        const reminderKind = state?.bridgeSetupAt
          ? OptionalEmailReminderKind.FirstSession
          : OptionalEmailReminderKind.BridgeSetup;
        report.candidates += 1;
        report.segments[reminderKind] += 1;
        const eligibility = await this.#eligibility.evaluateDryRun({ userId, reminderKind });
        if (eligibility.eligible) {
          report.eligible += 1;
        } else {
          report.blockedByReason[eligibility.reason] = (report.blockedByReason[eligibility.reason] ?? 0) + 1;
        }
      }
      afterUserId = userIds.at(-1) ?? null;
      if (userIds.length < input.batchLimit) {
        break;
      }
    }
    return report;
  }
}

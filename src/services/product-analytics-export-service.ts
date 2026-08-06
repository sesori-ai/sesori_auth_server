import { randomUUID } from "node:crypto";
import { InternalServerError, safeErrorType } from "../lib/errors.js";
import {
  copyProductAnalyticsPseudonymizationKey,
  productAnalyticsUserKeyFor,
} from "../lib/product-analytics-user-key.js";
import type {
  ProductAnalyticsActivationMilestones,
  ProductAnalyticsExportRow,
  ProductAnalyticsExportRunMetadata,
  ProductAnalyticsExportUser,
  ProductAnalyticsPreferenceChange,
  ProductAnalyticsSetupCohortRow,
} from "../models/product-analytics-export.js";
import type { ProductAnalyticsInternalExclusionSnapshot } from "../repositories/product-analytics-control-repo.js";
import type { ProductAnalyticsExportRun } from "../repositories/product-analytics-export-repo.js";
import { ProductAnalyticsPreference } from "../types/product-analytics.js";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
// Staging outlives any reasonable run, expires before the next daily cadence,
// and caps leaked-run storage cost.
const stagingLifetimeMs = millisecondsPerDay;

type ProductAnalyticsExportUserRepository = {
  findProductAnalyticsExportBatch(input: {
    afterUserId: string | null;
    batchLimit: number;
    createdAtOrBefore: Date;
  }): Promise<ProductAnalyticsExportUser[]>;
  findProductAnalyticsPreferenceChangeBatch(input: {
    afterUserId: string | null;
    batchLimit: number;
    changedAfter: Date;
  }): Promise<ProductAnalyticsPreferenceChange[]>;
};

type ProductAnalyticsExportActivationRepository = {
  findProductAnalyticsMilestonesByUserIds(input: {
    userIds: string[];
    runCutoff: Date;
  }): Promise<Map<string, ProductAnalyticsActivationMilestones>>;
};

type ProductAnalyticsExportControlRepository = {
  loadActiveInternalUserKeys(input: { loadedAt: Date }): Promise<ProductAnalyticsInternalExclusionSnapshot>;
};

type ProductAnalyticsExportStagingRepository = {
  beginRun(input: { runId: string; runCutoff: Date; expiresAt: Date }): Promise<ProductAnalyticsExportRun>;
  appendMilestones(input: { run: ProductAnalyticsExportRun; rows: ProductAnalyticsExportRow[] }): Promise<void>;
  writeCohorts(input: { run: ProductAnalyticsExportRun; rows: ProductAnalyticsSetupCohortRow[] }): Promise<void>;
  removeUserKeys(input: { run: ProductAnalyticsExportRun; userKeys: string[] }): Promise<Map<string, number>>;
  validateAndPromote(input: {
    run: ProductAnalyticsExportRun;
    expectedMilestoneRows: number;
    expectedTotalAccounts: number;
    expectedEnabledAccounts: number;
    metadata: ProductAnalyticsExportRunMetadata;
  }): Promise<void>;
  cleanup(input: { run: ProductAnalyticsExportRun }): Promise<void>;
};

type MutableSetupCohort = Omit<ProductAnalyticsSetupCohortRow, "exportedAt">;

export type ProductAnalyticsExportProgress = {
  usersScanned: number;
  milestoneRowsStaged: number;
  sourceSuppressedUsers: number;
  internalUsers: number;
  preCreationMilestonesDropped: number;
};

export type ProductAnalyticsExportReport = ProductAnalyticsExportProgress & {
  runCutoff: Date;
  preferenceScanCutoff: Date;
  controlUpdatedAt: Date;
  externalAccounts: number;
  enabledAccounts: number;
  optedOutAccounts: number;
  preferenceAfterCutoffAccounts: number;
  latePreferenceRowsRemoved: number;
  cohortRows: number;
};

function cohortWeekFor(accountCreatedAt: Date): string {
  const date = new Date(
    Date.UTC(accountCreatedAt.getUTCFullYear(), accountCreatedAt.getUTCMonth(), accountCreatedAt.getUTCDate()),
  );
  // Monday-based ISO week: getUTCDay() is 0=Sun..6=Sat, so this yields 0=Mon..6=Sun.
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

/**
 * Drops milestone timestamps that precede account creation. Legacy device-token
 * rows can survive account re-registration with their original `createdAt`, so
 * reconciled milestones may predate `users.createdAt`. Such evidence is
 * unusable for time-bound metrics; staging it would fail the pre-promotion
 * timestamp invariant. Dropped values are counted, never silently rewritten.
 */
function sanitizedMilestones(input: {
  milestones: ProductAnalyticsActivationMilestones;
  accountCreatedAt: Date;
  onDrop: () => void;
}): ProductAnalyticsActivationMilestones {
  const sanitize = (milestoneAt: Date | null): Date | null => {
    if (milestoneAt && milestoneAt < input.accountCreatedAt) {
      input.onDrop();
      return null;
    }
    return milestoneAt;
  };
  return {
    notificationRegisteredAt: sanitize(input.milestones.notificationRegisteredAt),
    bridgeRegisteredAt: sanitize(input.milestones.bridgeRegisteredAt),
    legacyFirstMetadataRequestAt: sanitize(input.milestones.legacyFirstMetadataRequestAt),
  };
}

function occurredWithin(input: { milestoneAt: Date | null; accountCreatedAt: Date; days: number }): boolean {
  if (!input.milestoneAt) {
    return false;
  }
  const elapsed = input.milestoneAt.getTime() - input.accountCreatedAt.getTime();
  return elapsed >= 0 && elapsed <= input.days * millisecondsPerDay;
}

function emptyCohort(input: { cohortWeek: string }): MutableSetupCohort {
  return {
    cohortWeek: input.cohortWeek,
    totalAccounts: 0,
    enabledAccounts: 0,
    notificationRegisteredWithin1Day: 0,
    notificationRegisteredWithin7Days: 0,
    notificationRegisteredWithin30Days: 0,
    bridgeRegisteredWithin1Day: 0,
    bridgeRegisteredWithin7Days: 0,
    bridgeRegisteredWithin30Days: 0,
    legacyFirstMetadataRequestWithin1Day: 0,
    legacyFirstMetadataRequestWithin7Days: 0,
    legacyFirstMetadataRequestWithin30Days: 0,
  };
}

function incrementCohort(input: {
  cohort: MutableSetupCohort;
  accountCreatedAt: Date;
  milestones: ProductAnalyticsActivationMilestones;
  enabled: boolean;
}): void {
  input.cohort.totalAccounts += 1;
  input.cohort.enabledAccounts += input.enabled ? 1 : 0;
  input.cohort.notificationRegisteredWithin1Day += occurredWithin({
    milestoneAt: input.milestones.notificationRegisteredAt,
    accountCreatedAt: input.accountCreatedAt,
    days: 1,
  })
    ? 1
    : 0;
  input.cohort.notificationRegisteredWithin7Days += occurredWithin({
    milestoneAt: input.milestones.notificationRegisteredAt,
    accountCreatedAt: input.accountCreatedAt,
    days: 7,
  })
    ? 1
    : 0;
  input.cohort.notificationRegisteredWithin30Days += occurredWithin({
    milestoneAt: input.milestones.notificationRegisteredAt,
    accountCreatedAt: input.accountCreatedAt,
    days: 30,
  })
    ? 1
    : 0;
  input.cohort.bridgeRegisteredWithin1Day += occurredWithin({
    milestoneAt: input.milestones.bridgeRegisteredAt,
    accountCreatedAt: input.accountCreatedAt,
    days: 1,
  })
    ? 1
    : 0;
  input.cohort.bridgeRegisteredWithin7Days += occurredWithin({
    milestoneAt: input.milestones.bridgeRegisteredAt,
    accountCreatedAt: input.accountCreatedAt,
    days: 7,
  })
    ? 1
    : 0;
  input.cohort.bridgeRegisteredWithin30Days += occurredWithin({
    milestoneAt: input.milestones.bridgeRegisteredAt,
    accountCreatedAt: input.accountCreatedAt,
    days: 30,
  })
    ? 1
    : 0;
  input.cohort.legacyFirstMetadataRequestWithin1Day += occurredWithin({
    milestoneAt: input.milestones.legacyFirstMetadataRequestAt,
    accountCreatedAt: input.accountCreatedAt,
    days: 1,
  })
    ? 1
    : 0;
  input.cohort.legacyFirstMetadataRequestWithin7Days += occurredWithin({
    milestoneAt: input.milestones.legacyFirstMetadataRequestAt,
    accountCreatedAt: input.accountCreatedAt,
    days: 7,
  })
    ? 1
    : 0;
  input.cohort.legacyFirstMetadataRequestWithin30Days += occurredWithin({
    milestoneAt: input.milestones.legacyFirstMetadataRequestAt,
    accountCreatedAt: input.accountCreatedAt,
    days: 30,
  })
    ? 1
    : 0;
}

function stringSetsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export class ProductAnalyticsExportService {
  readonly #userRepo: ProductAnalyticsExportUserRepository;
  readonly #activationStateRepo: ProductAnalyticsExportActivationRepository;
  readonly #controlRepo: ProductAnalyticsExportControlRepository;
  readonly #exportRepo: ProductAnalyticsExportStagingRepository;
  readonly #batchLimit: number;
  readonly #pseudonymizationKey: Buffer;
  readonly #clock: () => Date;
  readonly #createRunId: () => string;

  constructor(deps: {
    userRepo: ProductAnalyticsExportUserRepository;
    activationStateRepo: ProductAnalyticsExportActivationRepository;
    controlRepo: ProductAnalyticsExportControlRepository;
    exportRepo: ProductAnalyticsExportStagingRepository;
    batchLimit: number;
    pseudonymizationKey: Uint8Array;
    clock?: () => Date;
    createRunId?: () => string;
  }) {
    if (!Number.isSafeInteger(deps.batchLimit) || deps.batchLimit < 1 || deps.batchLimit > 1_000) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics export service batch limit" });
    }
    this.#userRepo = deps.userRepo;
    this.#activationStateRepo = deps.activationStateRepo;
    this.#controlRepo = deps.controlRepo;
    this.#exportRepo = deps.exportRepo;
    this.#batchLimit = deps.batchLimit;
    this.#pseudonymizationKey = copyProductAnalyticsPseudonymizationKey({ value: deps.pseudonymizationKey });
    this.#clock = deps.clock ?? (() => new Date());
    this.#createRunId = deps.createRunId ?? (() => randomUUID().replaceAll("-", ""));
  }

  /**
   * Builds one cutoff-pinned auth snapshot in three phases: scan and stage
   * eligible users, reconcile post-cutoff preference changes, then revalidate
   * controls and atomically promote. Any failure preserves the last published
   * snapshot and reaches staging cleanup in `finally`.
   */
  async run(input: {
    runCutoff: Date;
    onBatchComplete?: (progress: ProductAnalyticsExportProgress) => void;
  }): Promise<ProductAnalyticsExportReport> {
    const startedAt = this.#clock();
    if (Number.isNaN(input.runCutoff.getTime()) || Number.isNaN(startedAt.getTime()) || input.runCutoff > startedAt) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics export run cutoff" });
    }

    const control = await this.#controlRepo.loadActiveInternalUserKeys({ loadedAt: startedAt });
    let run: ProductAnalyticsExportRun | null = null;
    let completed = false;
    try {
      run = await this.#exportRepo.beginRun({
        runId: this.#createRunId(),
        runCutoff: input.runCutoff,
        expiresAt: new Date(startedAt.getTime() + stagingLifetimeMs),
      });
      // Phase 1: scan users at runCutoff, filter controls, stage keyed rows, and accumulate cohorts.
      const cohorts = new Map<string, MutableSetupCohort>();
      const progress: ProductAnalyticsExportProgress = {
        usersScanned: 0,
        milestoneRowsStaged: 0,
        sourceSuppressedUsers: 0,
        internalUsers: 0,
        preCreationMilestonesDropped: 0,
      };
      let externalAccounts = 0;
      let enabledAccounts = 0;
      let optedOutAccounts = 0;
      let preferenceAfterCutoffAccounts = 0;
      let afterUserId: string | null = null;

      while (true) {
        const users = await this.#userRepo.findProductAnalyticsExportBatch({
          afterUserId,
          batchLimit: this.#batchLimit,
          createdAtOrBefore: input.runCutoff,
        });
        if (users.length === 0) {
          break;
        }
        const milestonesByUserId = await this.#activationStateRepo.findProductAnalyticsMilestonesByUserIds({
          userIds: users.map((user) => user.userId),
          runCutoff: input.runCutoff,
        });
        const milestoneRows: ProductAnalyticsExportRow[] = [];
        for (const user of users) {
          progress.usersScanned += 1;
          if (user.exportSuppressedAt) {
            progress.sourceSuppressedUsers += 1;
            continue;
          }
          const userKey = productAnalyticsUserKeyFor({
            userId: user.userId,
            pseudonymizationKey: this.#pseudonymizationKey,
          });
          if (control.userKeys.has(userKey)) {
            progress.internalUsers += 1;
            continue;
          }
          externalAccounts += 1;
          const milestones = sanitizedMilestones({
            milestones: milestonesByUserId.get(user.userId) ?? {
              notificationRegisteredAt: null,
              bridgeRegisteredAt: null,
              legacyFirstMetadataRequestAt: null,
            },
            accountCreatedAt: user.accountCreatedAt,
            onDrop: () => {
              progress.preCreationMilestonesDropped += 1;
            },
          });
          const preferenceKnownAtCutoff = user.preferenceUpdatedAt <= input.runCutoff;
          const enabled = preferenceKnownAtCutoff && user.preference === ProductAnalyticsPreference.Enabled;
          if (!preferenceKnownAtCutoff) {
            preferenceAfterCutoffAccounts += 1;
          } else if (!enabled) {
            optedOutAccounts += 1;
          }
          const cohortWeek = cohortWeekFor(user.accountCreatedAt);
          const cohort = cohorts.get(cohortWeek) ?? emptyCohort({ cohortWeek });
          incrementCohort({ cohort, accountCreatedAt: user.accountCreatedAt, milestones, enabled });
          cohorts.set(cohortWeek, cohort);
          if (enabled) {
            enabledAccounts += 1;
            milestoneRows.push({
              userKey,
              accountCreatedAt: user.accountCreatedAt,
              notificationRegisteredAt: milestones.notificationRegisteredAt,
              bridgeRegisteredAt: milestones.bridgeRegisteredAt,
              legacyFirstMetadataRequestAt: milestones.legacyFirstMetadataRequestAt,
              exportedAt: input.runCutoff,
            });
          }
        }
        await this.#exportRepo.appendMilestones({ run, rows: milestoneRows });
        progress.milestoneRowsStaged += milestoneRows.length;
        afterUserId = users.at(-1)?.userId ?? null;
        input.onBatchComplete?.({ ...progress });
      }

      // Phase 2: reconcile current post-cutoff preferences before publication.
      const preferenceScanCutoff = this.#clock();
      if (Number.isNaN(preferenceScanCutoff.getTime()) || preferenceScanCutoff < input.runCutoff) {
        throw new InternalServerError({ debugMessage: "Invalid product analytics preference scan cutoff" });
      }
      let latePreferenceRowsRemoved = 0;
      let afterPreferenceUserId: string | null = null;
      while (true) {
        // Intentionally omit an upper timestamp bound. The document stores only
        // its latest preference timestamp, so a later write must not hide an
        // earlier change inside (runCutoff, preferenceScanCutoff]. Changes after
        // the scan starts are therefore excluded conservatively when observed.
        const changes = await this.#userRepo.findProductAnalyticsPreferenceChangeBatch({
          afterUserId: afterPreferenceUserId,
          batchLimit: this.#batchLimit,
          changedAfter: input.runCutoff,
        });
        if (changes.length === 0) {
          break;
        }
        if (changes.some((change) => change.exportSuppressedAt !== null)) {
          throw new InternalServerError({
            debugMessage: "Product analytics source suppression changed during export",
          });
        }
        const removedByCohort = await this.#exportRepo.removeUserKeys({
          run,
          userKeys: changes.map((change) =>
            productAnalyticsUserKeyFor({
              userId: change.userId,
              pseudonymizationKey: this.#pseudonymizationKey,
            }),
          ),
        });
        for (const [cohortWeek, removedCount] of removedByCohort) {
          const cohort = cohorts.get(cohortWeek);
          if (!cohort || removedCount > cohort.enabledAccounts) {
            throw new InternalServerError({ debugMessage: "Invalid product analytics late-preference reconciliation" });
          }
          cohort.enabledAccounts -= removedCount;
          enabledAccounts -= removedCount;
          progress.milestoneRowsStaged -= removedCount;
          latePreferenceRowsRemoved += removedCount;
        }
        afterPreferenceUserId = changes.at(-1)?.userId ?? null;
      }

      // Phase 3: revalidate controls, write aggregate cohorts, validate, and atomically promote.
      const finalControlLoadedAt = this.#clock();
      if (Number.isNaN(finalControlLoadedAt.getTime()) || finalControlLoadedAt < preferenceScanCutoff) {
        throw new InternalServerError({ debugMessage: "Invalid product analytics final control load time" });
      }
      const finalControl = await this.#controlRepo.loadActiveInternalUserKeys({ loadedAt: finalControlLoadedAt });
      if (
        finalControl.controlUpdatedAt.getTime() !== control.controlUpdatedAt.getTime() ||
        !stringSetsEqual(finalControl.userKeys, control.userKeys)
      ) {
        throw new InternalServerError({ debugMessage: "Product analytics internal exclusions changed during export" });
      }

      const cohortRows = [...cohorts.values()]
        .sort((left, right) => left.cohortWeek.localeCompare(right.cohortWeek))
        .map((cohort) => ({ ...cohort, exportedAt: input.runCutoff }));
      await this.#exportRepo.writeCohorts({ run, rows: cohortRows });
      await this.#exportRepo.validateAndPromote({
        run,
        expectedMilestoneRows: progress.milestoneRowsStaged,
        expectedTotalAccounts: externalAccounts,
        expectedEnabledAccounts: enabledAccounts,
        metadata: {
          runId: run.runId,
          runCutoff: input.runCutoff,
          preferenceScanCutoff,
          controlUpdatedAt: control.controlUpdatedAt,
          usersScanned: progress.usersScanned,
          sourceSuppressedUsers: progress.sourceSuppressedUsers,
          internalUsers: progress.internalUsers,
          externalAccounts,
          enabledAccounts,
          optedOutAccounts,
          preferenceAfterCutoffAccounts,
          latePreferenceRowsRemoved,
          milestoneRowsPublished: progress.milestoneRowsStaged,
          cohortRowsPublished: cohortRows.length,
        },
      });
      completed = true;
      return {
        ...progress,
        runCutoff: input.runCutoff,
        preferenceScanCutoff,
        controlUpdatedAt: control.controlUpdatedAt,
        externalAccounts,
        enabledAccounts,
        optedOutAccounts,
        preferenceAfterCutoffAccounts,
        latePreferenceRowsRemoved,
        cohortRows: cohortRows.length,
      };
    } finally {
      if (run) {
        try {
          await this.#exportRepo.cleanup({ run });
        } catch (error) {
          console.error("[ProductAnalyticsExport] Staging cleanup failed", {
            completed,
            errorType: safeErrorType({ error }),
            failureCount: error instanceof AggregateError ? error.errors.length : 1,
          });
        }
      }
    }
  }
}

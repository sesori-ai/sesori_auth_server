import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productAnalyticsUserKeyFor } from "../../src/lib/product-analytics-user-key.js";
import type {
  ProductAnalyticsActivationMilestones,
  ProductAnalyticsExportRow,
  ProductAnalyticsExportUser,
  ProductAnalyticsPreferenceChange,
  ProductAnalyticsSetupCohortRow,
} from "../../src/models/product-analytics-export.js";
import type { ProductAnalyticsExportRun } from "../../src/repositories/product-analytics-export-repo.js";
import { ProductAnalyticsExportService } from "../../src/services/product-analytics-export-service.js";
import { ProductAnalyticsPreference } from "../../src/types/product-analytics.js";

const run: ProductAnalyticsExportRun = {
  runId: "testrun01",
  milestoneStagingTableId: "auth_user_milestones_staging_testrun01",
  cohortStagingTableId: "auth_weekly_setup_cohorts_staging_testrun01",
};

function weekFor(date: Date): string {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  copy.setUTCDate(copy.getUTCDate() - ((copy.getUTCDay() + 6) % 7));
  return copy.toISOString().slice(0, 10);
}

class FakeUserRepository {
  constructor(
    readonly users: ProductAnalyticsExportUser[],
    readonly changes: ProductAnalyticsPreferenceChange[],
  ) {}

  async findProductAnalyticsExportBatch(input: {
    afterUserId: string | null;
    batchLimit: number;
    createdAtOrBefore: Date;
  }): Promise<ProductAnalyticsExportUser[]> {
    return this.users
      .filter(
        (user) =>
          user.accountCreatedAt <= input.createdAtOrBefore &&
          (input.afterUserId === null || user.userId > input.afterUserId),
      )
      .slice(0, input.batchLimit);
  }

  async findProductAnalyticsPreferenceChangeBatch(input: {
    afterUserId: string | null;
    batchLimit: number;
    changedAfter: Date;
  }): Promise<ProductAnalyticsPreferenceChange[]> {
    return this.changes
      .filter(
        (change) =>
          change.changedAt > input.changedAfter && (input.afterUserId === null || change.userId > input.afterUserId),
      )
      .slice(0, input.batchLimit);
  }
}

class FakeActivationStateRepository {
  constructor(readonly milestones: Map<string, ProductAnalyticsActivationMilestones>) {}

  async findProductAnalyticsMilestonesByUserIds(input: {
    userIds: string[];
  }): Promise<Map<string, ProductAnalyticsActivationMilestones>> {
    return new Map(
      input.userIds.flatMap((userId) => (this.milestones.has(userId) ? [[userId, this.milestones.get(userId)!]] : [])),
    );
  }
}

class FakeExportRepository {
  readonly milestones: ProductAnalyticsExportRow[] = [];
  cohorts: ProductAnalyticsSetupCohortRow[] = [];
  validationInput: {
    expectedMilestoneRows: number;
    expectedTotalAccounts: number;
    expectedEnabledAccounts: number;
  } | null = null;
  cleanupCalls = 0;
  failAppend = false;

  async beginRun(): Promise<ProductAnalyticsExportRun> {
    return run;
  }

  async appendMilestones(input: { rows: ProductAnalyticsExportRow[] }): Promise<void> {
    if (this.failAppend) {
      throw new Error("staging failed");
    }
    this.milestones.push(...input.rows);
  }

  async writeCohorts(input: { rows: ProductAnalyticsSetupCohortRow[] }): Promise<void> {
    this.cohorts = input.rows;
  }

  async removeUserKeys(input: { userKeys: string[] }): Promise<Map<string, number>> {
    const removed = new Map<string, number>();
    for (let index = this.milestones.length - 1; index >= 0; index -= 1) {
      const row = this.milestones[index];
      if (input.userKeys.includes(row.userKey)) {
        const week = weekFor(row.accountCreatedAt);
        removed.set(week, (removed.get(week) ?? 0) + 1);
        this.milestones.splice(index, 1);
      }
    }
    return removed;
  }

  async validateAndPromote(input: {
    expectedMilestoneRows: number;
    expectedTotalAccounts: number;
    expectedEnabledAccounts: number;
    metadata: unknown;
  }): Promise<void> {
    this.validationInput = input;
  }

  async cleanup(): Promise<void> {
    this.cleanupCalls += 1;
  }
}

describe("ProductAnalyticsExportService", () => {
  it("pins the lowercase canonical account-key hash", () => {
    assert.equal(
      productAnalyticsUserKeyFor({ userId: "000000000000000000000001" }),
      "dd6eda34d13e0eb25636eb5642192e8d72b05147f23270f982dd136ffe8d9193",
    );
    assert.equal(
      productAnalyticsUserKeyFor({ userId: "abcdefabcdefabcdefabcdef" }),
      productAnalyticsUserKeyFor({ userId: "ABCDEFABCDEFABCDEFABCDEF" }),
    );
  });

  it("filters before aggregation, reconciles late preference changes, and promotes both products", async () => {
    const runCutoff = new Date("2026-07-28T12:00:00.000Z");
    const startedAt = new Date("2026-07-28T12:01:00.000Z");
    const preferenceScanCutoff = new Date("2026-07-28T12:02:00.000Z");
    const ids = Array.from({ length: 6 }, (_, index) => `00000000000000000000000${index + 1}`);
    const createdThisWeek = new Date("2026-07-20T12:00:00.000Z");
    const createdLastWeek = new Date("2026-07-13T12:00:00.000Z");
    const users: ProductAnalyticsExportUser[] = [
      {
        userId: ids[0],
        accountCreatedAt: createdThisWeek,
        preference: ProductAnalyticsPreference.Enabled,
        preferenceUpdatedAt: createdThisWeek,
        exportSuppressedAt: null,
      },
      {
        userId: ids[1],
        accountCreatedAt: createdThisWeek,
        preference: ProductAnalyticsPreference.Disabled,
        preferenceUpdatedAt: createdThisWeek,
        exportSuppressedAt: null,
      },
      {
        userId: ids[2],
        accountCreatedAt: createdThisWeek,
        preference: ProductAnalyticsPreference.Enabled,
        preferenceUpdatedAt: createdThisWeek,
        exportSuppressedAt: null,
      },
      {
        userId: ids[3],
        accountCreatedAt: createdThisWeek,
        preference: ProductAnalyticsPreference.Disabled,
        preferenceUpdatedAt: createdThisWeek,
        exportSuppressedAt: new Date("2026-07-25T12:00:00.000Z"),
      },
      {
        userId: ids[4],
        accountCreatedAt: createdThisWeek,
        preference: ProductAnalyticsPreference.Enabled,
        preferenceUpdatedAt: new Date("2026-07-28T12:00:01.000Z"),
        exportSuppressedAt: null,
      },
      {
        userId: ids[5],
        accountCreatedAt: createdLastWeek,
        preference: ProductAnalyticsPreference.Enabled,
        preferenceUpdatedAt: createdLastWeek,
        exportSuppressedAt: null,
      },
    ];
    const userRepo = new FakeUserRepository(users, [
      {
        userId: ids[5],
        changedAt: new Date("2026-07-28T12:01:30.000Z"),
        exportSuppressedAt: null,
      },
    ]);
    const activationRepo = new FakeActivationStateRepository(
      new Map([
        [
          ids[0],
          {
            notificationRegisteredAt: new Date("2026-07-21T12:00:00.000Z"),
            bridgeRegisteredAt: new Date("2026-07-28T12:00:00.000Z"),
            legacyFirstMetadataRequestAt: null,
          },
        ],
      ]),
    );
    const exportRepo = new FakeExportRepository();
    const clockValues = [startedAt, preferenceScanCutoff];
    const service = new ProductAnalyticsExportService({
      userRepo,
      activationStateRepo: activationRepo,
      controlRepo: {
        async loadActiveInternalUserKeys() {
          return {
            userKeys: new Set([productAnalyticsUserKeyFor({ userId: ids[2] })]),
            controlUpdatedAt: new Date("2026-07-28T00:00:00.000Z"),
          };
        },
      },
      exportRepo,
      batchLimit: 2,
      clock: () => clockValues.shift()!,
      createRunId: () => "testrun01",
    });

    const report = await service.run({ runCutoff });

    assert.equal(report.usersScanned, 6);
    assert.equal(report.sourceSuppressedUsers, 1);
    assert.equal(report.internalUsers, 1);
    assert.equal(report.externalAccounts, 4);
    assert.equal(report.enabledAccounts, 1);
    assert.equal(report.optedOutAccounts, 1);
    assert.equal(report.preferenceAfterCutoffAccounts, 1);
    assert.equal(report.latePreferenceRowsRemoved, 1);
    assert.equal(report.milestoneRowsStaged, 1);
    assert.equal(report.cohortRows, 2);
    assert.equal(exportRepo.cleanupCalls, 1);
    assert.equal(exportRepo.validationInput?.expectedMilestoneRows, 1);
    assert.equal(exportRepo.validationInput?.expectedTotalAccounts, 4);
    assert.equal(exportRepo.validationInput?.expectedEnabledAccounts, 1);
    assert.deepEqual((exportRepo.validationInput as unknown as { metadata: Record<string, unknown> }).metadata, {
      runId: "testrun01",
      runCutoff,
      preferenceScanCutoff,
      controlUpdatedAt: new Date("2026-07-28T00:00:00.000Z"),
      usersScanned: 6,
      sourceSuppressedUsers: 1,
      internalUsers: 1,
      externalAccounts: 4,
      enabledAccounts: 1,
      optedOutAccounts: 1,
      preferenceAfterCutoffAccounts: 1,
      latePreferenceRowsRemoved: 1,
      milestoneRowsPublished: 1,
      cohortRowsPublished: 2,
    });
    assert.equal(exportRepo.milestones.length, 1);
    assert.equal(exportRepo.milestones[0].userKey, productAnalyticsUserKeyFor({ userId: ids[0] }));
    assert.equal(Object.hasOwn(exportRepo.milestones[0], "userId"), false);
    assert.deepEqual(
      exportRepo.cohorts.map((cohort) => ({
        week: cohort.cohortWeek,
        total: cohort.totalAccounts,
        enabled: cohort.enabledAccounts,
        notification1: cohort.notificationRegisteredWithin1Day,
        bridge7: cohort.bridgeRegisteredWithin7Days,
        bridge30: cohort.bridgeRegisteredWithin30Days,
      })),
      [
        { week: "2026-07-13", total: 1, enabled: 0, notification1: 0, bridge7: 0, bridge30: 0 },
        { week: "2026-07-20", total: 3, enabled: 1, notification1: 1, bridge7: 0, bridge30: 1 },
      ],
    );
  });

  it("leaves publication untouched and still cleans staging after a failed page", async () => {
    const exportRepo = new FakeExportRepository();
    exportRepo.failAppend = true;
    const user: ProductAnalyticsExportUser = {
      userId: "000000000000000000000001",
      accountCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
      preference: ProductAnalyticsPreference.Enabled,
      preferenceUpdatedAt: new Date("2026-07-20T12:00:00.000Z"),
      exportSuppressedAt: null,
    };
    const service = new ProductAnalyticsExportService({
      userRepo: new FakeUserRepository([user], []),
      activationStateRepo: new FakeActivationStateRepository(new Map()),
      controlRepo: {
        async loadActiveInternalUserKeys() {
          return { userKeys: new Set<string>(), controlUpdatedAt: new Date("2026-07-28T00:00:00.000Z") };
        },
      },
      exportRepo,
      batchLimit: 2,
      clock: () => new Date("2026-07-28T12:01:00.000Z"),
      createRunId: () => "testrun01",
    });

    await assert.rejects(() => service.run({ runCutoff: new Date("2026-07-28T12:00:00.000Z") }), /staging failed/);
    assert.equal(exportRepo.validationInput, null);
    assert.equal(exportRepo.cleanupCalls, 1);
  });

  it("aborts publication when source suppression lands during the run", async () => {
    const runCutoff = new Date("2026-07-28T12:00:00.000Z");
    const user: ProductAnalyticsExportUser = {
      userId: "000000000000000000000001",
      accountCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
      preference: ProductAnalyticsPreference.Enabled,
      preferenceUpdatedAt: new Date("2026-07-20T12:00:00.000Z"),
      exportSuppressedAt: null,
    };
    const exportRepo = new FakeExportRepository();
    const service = new ProductAnalyticsExportService({
      userRepo: new FakeUserRepository(
        [user],
        [
          {
            userId: user.userId,
            changedAt: new Date("2026-07-28T12:01:30.000Z"),
            exportSuppressedAt: new Date("2026-07-28T12:01:30.000Z"),
          },
        ],
      ),
      activationStateRepo: new FakeActivationStateRepository(new Map()),
      controlRepo: {
        async loadActiveInternalUserKeys() {
          return { userKeys: new Set<string>(), controlUpdatedAt: new Date("2026-07-28T00:00:00.000Z") };
        },
      },
      exportRepo,
      batchLimit: 2,
      clock: (() => {
        const values = [new Date("2026-07-28T12:01:00.000Z"), new Date("2026-07-28T12:02:00.000Z")];
        return () => values.shift()!;
      })(),
      createRunId: () => "testrun01",
    });

    await assert.rejects(
      () => service.run({ runCutoff }),
      (error: unknown) =>
        error instanceof Error && error.message === "internal_server_error" && exportRepo.validationInput === null,
    );
    assert.equal(exportRepo.cleanupCalls, 1);
  });
});

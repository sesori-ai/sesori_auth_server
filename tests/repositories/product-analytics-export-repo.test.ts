import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TableField } from "@google-cloud/bigquery";
import { InternalServerError } from "../../src/lib/errors.js";
import type { ProductAnalyticsExternalQueryRow } from "../../src/api/product-analytics-export-api.js";
import type {
  ProductAnalyticsExportRow,
  ProductAnalyticsExportRunMetadata,
  ProductAnalyticsSetupCohortRow,
} from "../../src/models/product-analytics-export.js";
import { ProductAnalyticsExportRepository } from "../../src/repositories/product-analytics-export-repo.js";

class FakeExportApi {
  readonly datasetReference = "valid-project.auth_private";
  readonly created: Array<{
    tableId: string;
    schema: TableField[];
    expiresAt: Date | null;
    ifNotExists: boolean;
  }> = [];
  readonly queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  readonly deleted: string[] = [];
  validationRow: ProductAnalyticsExternalQueryRow = {
    milestone_rows: 1,
    duplicate_keys: 0,
    invalid_keys: 0,
    invalid_timestamps: 0,
    total_accounts: 2,
    enabled_accounts: 1,
    invalid_cohorts: 0,
  };

  async createTable(input: {
    tableId: string;
    schema: TableField[];
    expiresAt: Date | null;
    ifNotExists: boolean;
  }): Promise<void> {
    this.created.push(input);
  }

  async query(input: { sql: string; params?: Record<string, unknown> }): Promise<ProductAnalyticsExternalQueryRow[]> {
    this.queries.push(input);
    if (input.sql.includes("AS milestone_rows")) {
      return [this.validationRow];
    }
    if (input.sql.includes("AS removed_count")) {
      return [{ cohort_week: "2026-07-20", removed_count: 1 }];
    }
    return [];
  }

  async deleteTable(input: { tableId: string }): Promise<void> {
    this.deleted.push(input.tableId);
  }
}

describe("ProductAnalyticsExportRepository", () => {
  const exportedAt = new Date("2026-07-28T12:00:00.000Z");
  const milestone: ProductAnalyticsExportRow = {
    userKey: "a".repeat(64),
    accountCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
    notificationRegisteredAt: new Date("2026-07-21T12:00:00.000Z"),
    bridgeRegisteredAt: null,
    legacyFirstMetadataRequestAt: null,
    exportedAt,
  };
  const cohort: ProductAnalyticsSetupCohortRow = {
    cohortWeek: "2026-07-20",
    totalAccounts: 2,
    enabledAccounts: 1,
    notificationRegisteredWithin1Day: 1,
    notificationRegisteredWithin7Days: 1,
    notificationRegisteredWithin30Days: 1,
    bridgeRegisteredWithin1Day: 0,
    bridgeRegisteredWithin7Days: 0,
    bridgeRegisteredWithin30Days: 0,
    legacyFirstMetadataRequestWithin1Day: 0,
    legacyFirstMetadataRequestWithin7Days: 0,
    legacyFirstMetadataRequestWithin30Days: 0,
    exportedAt,
  };
  const metadata: ProductAnalyticsExportRunMetadata = {
    runId: "testrun01",
    runCutoff: exportedAt,
    preferenceScanCutoff: new Date("2026-07-28T12:01:00.000Z"),
    controlUpdatedAt: new Date("2026-07-28T11:00:00.000Z"),
    usersScanned: 2,
    sourceSuppressedUsers: 0,
    internalUsers: 0,
    externalAccounts: 2,
    enabledAccounts: 1,
    optedOutAccounts: 1,
    preferenceAfterCutoffAccounts: 0,
    latePreferenceRowsRemoved: 0,
    milestoneRowsPublished: 1,
    cohortRowsPublished: 1,
  };

  it("uses expiring run-scoped staging and query jobs rather than streaming inserts", async () => {
    const api = new FakeExportApi();
    const repo = new ProductAnalyticsExportRepository({ api });
    const expiresAt = new Date("2026-07-29T12:00:00.000Z");
    const run = await repo.beginRun({ runId: "testrun01", expiresAt });
    await repo.appendMilestones({ run, rows: [milestone] });
    await repo.writeCohorts({ run, rows: [cohort] });

    assert.equal(api.created.length, 5);
    assert.deepEqual(
      api.created.map((entry) => [entry.tableId, entry.ifNotExists, entry.expiresAt?.toISOString() ?? null]),
      [
        ["auth_user_milestones", true, null],
        ["auth_weekly_setup_cohorts", true, null],
        ["product_analytics_export_runs", true, null],
        [run.milestoneStagingTableId, false, expiresAt.toISOString()],
        [run.cohortStagingTableId, false, expiresAt.toISOString()],
      ],
    );
    assert.equal(api.queries.length, 2);
    assert.match(api.queries[0].sql, /INSERT INTO/);
    assert.match(api.queries[1].sql, /INSERT INTO/);
    assert.equal((api.queries[0].params?.rows_json as string).includes(milestone.userKey), true);
  });

  it("removes late keys, validates reconciliation, and transactionally promotes both tables", async () => {
    const api = new FakeExportApi();
    const repo = new ProductAnalyticsExportRepository({ api });
    const run = await repo.beginRun({
      runId: "testrun01",
      expiresAt: new Date("2026-07-29T12:00:00.000Z"),
    });

    const removed = await repo.removeUserKeys({ run, userKeys: [milestone.userKey] });
    await repo.validateAndPromote({
      run,
      expectedMilestoneRows: 1,
      expectedTotalAccounts: 2,
      expectedEnabledAccounts: 1,
      metadata,
    });
    await repo.cleanup({ run });

    assert.deepEqual([...removed], [["2026-07-20", 1]]);
    assert.equal(
      api.queries.some((query) => query.sql.includes("DELETE FROM") && query.params?.user_keys),
      true,
    );
    const promotion = api.queries.find((query) => query.sql.includes("BEGIN TRANSACTION"));
    assert.ok(promotion);
    assert.match(promotion.sql, /auth_user_milestones/);
    assert.match(promotion.sql, /auth_weekly_setup_cohorts/);
    assert.match(promotion.sql, /product_analytics_export_runs/);
    assert.equal(promotion.params?.run_id, "testrun01");
    assert.deepEqual(api.deleted, [run.milestoneStagingTableId, run.cohortStagingTableId]);
  });

  it("does not publish when staging reconciliation fails", async () => {
    const api = new FakeExportApi();
    api.validationRow.enabled_accounts = 2;
    const repo = new ProductAnalyticsExportRepository({ api });
    const run = await repo.beginRun({
      runId: "testrun01",
      expiresAt: new Date("2026-07-29T12:00:00.000Z"),
    });

    await assert.rejects(
      () =>
        repo.validateAndPromote({
          run,
          expectedMilestoneRows: 1,
          expectedTotalAccounts: 2,
          expectedEnabledAccounts: 1,
          metadata,
        }),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Product analytics export validation failed",
    );
    assert.equal(
      api.queries.some((query) => query.sql.includes("BEGIN TRANSACTION")),
      false,
    );
  });
});

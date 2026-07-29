import type { TableField } from "@google-cloud/bigquery";
import type { ProductAnalyticsExternalQueryRow } from "../api/product-analytics-export-api.js";
import { InternalServerError } from "../lib/errors.js";
import type {
  ProductAnalyticsExportRow,
  ProductAnalyticsExportRunMetadata,
  ProductAnalyticsSetupCohortRow,
} from "../models/product-analytics-export.js";

const runIdPattern = /^[a-z0-9_]{8,80}$/;
const userKeyPattern = /^[a-f0-9]{64}$/;

const milestoneSchema: TableField[] = [
  { name: "user_key", type: "STRING", mode: "REQUIRED" },
  { name: "account_created_at", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "notification_registered_at", type: "TIMESTAMP", mode: "NULLABLE" },
  { name: "bridge_registered_at", type: "TIMESTAMP", mode: "NULLABLE" },
  { name: "legacy_first_metadata_request_at", type: "TIMESTAMP", mode: "NULLABLE" },
  { name: "exported_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

const cohortSchema: TableField[] = [
  { name: "cohort_week", type: "DATE", mode: "REQUIRED" },
  { name: "total_accounts", type: "INTEGER", mode: "REQUIRED" },
  { name: "enabled_accounts", type: "INTEGER", mode: "REQUIRED" },
  { name: "notification_registered_within_1_day", type: "INTEGER", mode: "REQUIRED" },
  { name: "notification_registered_within_7_days", type: "INTEGER", mode: "REQUIRED" },
  { name: "notification_registered_within_30_days", type: "INTEGER", mode: "REQUIRED" },
  { name: "bridge_registered_within_1_day", type: "INTEGER", mode: "REQUIRED" },
  { name: "bridge_registered_within_7_days", type: "INTEGER", mode: "REQUIRED" },
  { name: "bridge_registered_within_30_days", type: "INTEGER", mode: "REQUIRED" },
  { name: "legacy_first_metadata_request_within_1_day", type: "INTEGER", mode: "REQUIRED" },
  { name: "legacy_first_metadata_request_within_7_days", type: "INTEGER", mode: "REQUIRED" },
  { name: "legacy_first_metadata_request_within_30_days", type: "INTEGER", mode: "REQUIRED" },
  { name: "exported_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

const runMetadataSchema: TableField[] = [
  { name: "run_id", type: "STRING", mode: "REQUIRED" },
  { name: "run_cutoff", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "preference_scan_cutoff", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "control_updated_at", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "users_scanned", type: "INTEGER", mode: "REQUIRED" },
  { name: "source_suppressed_users", type: "INTEGER", mode: "REQUIRED" },
  { name: "internal_users", type: "INTEGER", mode: "REQUIRED" },
  { name: "external_accounts", type: "INTEGER", mode: "REQUIRED" },
  { name: "enabled_accounts", type: "INTEGER", mode: "REQUIRED" },
  { name: "opted_out_accounts", type: "INTEGER", mode: "REQUIRED" },
  { name: "preference_after_cutoff_accounts", type: "INTEGER", mode: "REQUIRED" },
  { name: "late_preference_rows_removed", type: "INTEGER", mode: "REQUIRED" },
  { name: "milestone_rows_published", type: "INTEGER", mode: "REQUIRED" },
  { name: "cohort_rows_published", type: "INTEGER", mode: "REQUIRED" },
  { name: "published_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export type ProductAnalyticsExportRun = {
  runId: string;
  milestoneStagingTableId: string;
  cohortStagingTableId: string;
};

type ProductAnalyticsExportDataApi = {
  readonly datasetReference: string;
  createTable(input: {
    tableId: string;
    schema: TableField[];
    expiresAt: Date | null;
    ifNotExists: boolean;
  }): Promise<void>;
  query(input: { sql: string; params?: Record<string, unknown> }): Promise<ProductAnalyticsExternalQueryRow[]>;
  deleteTable(input: { tableId: string }): Promise<void>;
};

function integerFromBigQuery(input: unknown): number | null {
  const value =
    typeof input === "object" && input !== null && "value" in input ? (input as { value: unknown }).value : input;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function stringFromBigQuery(input: unknown): string | null {
  const value =
    typeof input === "object" && input !== null && "value" in input ? (input as { value: unknown }).value : input;
  return typeof value === "string" ? value : null;
}

export class ProductAnalyticsExportRepository {
  readonly #api: ProductAnalyticsExportDataApi;

  constructor(deps: { api: ProductAnalyticsExportDataApi }) {
    this.#api = deps.api;
  }

  async beginRun(input: { runId: string; expiresAt: Date }): Promise<ProductAnalyticsExportRun> {
    if (!runIdPattern.test(input.runId) || Number.isNaN(input.expiresAt.getTime())) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics export run" });
    }
    const run = {
      runId: input.runId,
      milestoneStagingTableId: `auth_user_milestones_staging_${input.runId}`,
      cohortStagingTableId: `auth_weekly_setup_cohorts_staging_${input.runId}`,
    };
    await this.#api.createTable({
      tableId: "auth_user_milestones",
      schema: milestoneSchema,
      expiresAt: null,
      ifNotExists: true,
    });
    await this.#api.createTable({
      tableId: "auth_weekly_setup_cohorts",
      schema: cohortSchema,
      expiresAt: null,
      ifNotExists: true,
    });
    await this.#api.createTable({
      tableId: "product_analytics_export_runs",
      schema: runMetadataSchema,
      expiresAt: null,
      ifNotExists: true,
    });
    await this.#api.createTable({
      tableId: run.milestoneStagingTableId,
      schema: milestoneSchema,
      expiresAt: input.expiresAt,
      ifNotExists: false,
    });
    await this.#api.createTable({
      tableId: run.cohortStagingTableId,
      schema: cohortSchema,
      expiresAt: input.expiresAt,
      ifNotExists: false,
    });
    return run;
  }

  async appendMilestones(input: { run: ProductAnalyticsExportRun; rows: ProductAnalyticsExportRow[] }): Promise<void> {
    if (input.rows.length === 0) {
      return;
    }
    const rows = input.rows.map((row) => ({
      user_key: row.userKey,
      account_created_at: row.accountCreatedAt.toISOString(),
      notification_registered_at: row.notificationRegisteredAt?.toISOString() ?? null,
      bridge_registered_at: row.bridgeRegisteredAt?.toISOString() ?? null,
      legacy_first_metadata_request_at: row.legacyFirstMetadataRequestAt?.toISOString() ?? null,
      exported_at: row.exportedAt.toISOString(),
    }));
    await this.#api.query({
      sql: `
        INSERT INTO \`${this.#api.datasetReference}.${input.run.milestoneStagingTableId}\` (
          user_key,
          account_created_at,
          notification_registered_at,
          bridge_registered_at,
          legacy_first_metadata_request_at,
          exported_at
        )
        SELECT
          JSON_VALUE(row, '$.user_key'),
          TIMESTAMP(JSON_VALUE(row, '$.account_created_at')),
          CASE WHEN JSON_VALUE(row, '$.notification_registered_at') IS NULL THEN NULL ELSE TIMESTAMP(JSON_VALUE(row, '$.notification_registered_at')) END,
          CASE WHEN JSON_VALUE(row, '$.bridge_registered_at') IS NULL THEN NULL ELSE TIMESTAMP(JSON_VALUE(row, '$.bridge_registered_at')) END,
          CASE WHEN JSON_VALUE(row, '$.legacy_first_metadata_request_at') IS NULL THEN NULL ELSE TIMESTAMP(JSON_VALUE(row, '$.legacy_first_metadata_request_at')) END,
          TIMESTAMP(JSON_VALUE(row, '$.exported_at'))
        FROM UNNEST(JSON_QUERY_ARRAY(@rows_json)) AS row
      `,
      params: { rows_json: JSON.stringify(rows) },
    });
  }

  async writeCohorts(input: { run: ProductAnalyticsExportRun; rows: ProductAnalyticsSetupCohortRow[] }): Promise<void> {
    if (input.rows.length === 0) {
      return;
    }
    const rows = input.rows.map((row) => ({
      cohort_week: row.cohortWeek,
      total_accounts: row.totalAccounts,
      enabled_accounts: row.enabledAccounts,
      notification_registered_within_1_day: row.notificationRegisteredWithin1Day,
      notification_registered_within_7_days: row.notificationRegisteredWithin7Days,
      notification_registered_within_30_days: row.notificationRegisteredWithin30Days,
      bridge_registered_within_1_day: row.bridgeRegisteredWithin1Day,
      bridge_registered_within_7_days: row.bridgeRegisteredWithin7Days,
      bridge_registered_within_30_days: row.bridgeRegisteredWithin30Days,
      legacy_first_metadata_request_within_1_day: row.legacyFirstMetadataRequestWithin1Day,
      legacy_first_metadata_request_within_7_days: row.legacyFirstMetadataRequestWithin7Days,
      legacy_first_metadata_request_within_30_days: row.legacyFirstMetadataRequestWithin30Days,
      exported_at: row.exportedAt.toISOString(),
    }));
    await this.#api.query({
      sql: `
        INSERT INTO \`${this.#api.datasetReference}.${input.run.cohortStagingTableId}\` (
          cohort_week,
          total_accounts,
          enabled_accounts,
          notification_registered_within_1_day,
          notification_registered_within_7_days,
          notification_registered_within_30_days,
          bridge_registered_within_1_day,
          bridge_registered_within_7_days,
          bridge_registered_within_30_days,
          legacy_first_metadata_request_within_1_day,
          legacy_first_metadata_request_within_7_days,
          legacy_first_metadata_request_within_30_days,
          exported_at
        )
        SELECT
          DATE(JSON_VALUE(row, '$.cohort_week')),
          CAST(JSON_VALUE(row, '$.total_accounts') AS INT64),
          CAST(JSON_VALUE(row, '$.enabled_accounts') AS INT64),
          CAST(JSON_VALUE(row, '$.notification_registered_within_1_day') AS INT64),
          CAST(JSON_VALUE(row, '$.notification_registered_within_7_days') AS INT64),
          CAST(JSON_VALUE(row, '$.notification_registered_within_30_days') AS INT64),
          CAST(JSON_VALUE(row, '$.bridge_registered_within_1_day') AS INT64),
          CAST(JSON_VALUE(row, '$.bridge_registered_within_7_days') AS INT64),
          CAST(JSON_VALUE(row, '$.bridge_registered_within_30_days') AS INT64),
          CAST(JSON_VALUE(row, '$.legacy_first_metadata_request_within_1_day') AS INT64),
          CAST(JSON_VALUE(row, '$.legacy_first_metadata_request_within_7_days') AS INT64),
          CAST(JSON_VALUE(row, '$.legacy_first_metadata_request_within_30_days') AS INT64),
          TIMESTAMP(JSON_VALUE(row, '$.exported_at'))
        FROM UNNEST(JSON_QUERY_ARRAY(@rows_json)) AS row
      `,
      params: { rows_json: JSON.stringify(rows) },
    });
  }

  async removeUserKeys(input: { run: ProductAnalyticsExportRun; userKeys: string[] }): Promise<Map<string, number>> {
    if (input.userKeys.some((userKey) => !userKeyPattern.test(userKey))) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics exclusion key" });
    }
    if (input.userKeys.length === 0) {
      return new Map();
    }
    const rows = await this.#api.query({
      sql: `
        SELECT
          FORMAT_DATE('%F', DATE_TRUNC(DATE(account_created_at), WEEK(MONDAY))) AS cohort_week,
          COUNT(*) AS removed_count
        FROM \`${this.#api.datasetReference}.${input.run.milestoneStagingTableId}\`
        WHERE user_key IN UNNEST(@user_keys)
        GROUP BY cohort_week
      `,
      params: { user_keys: input.userKeys },
    });
    await this.#api.query({
      sql: `
        DELETE FROM \`${this.#api.datasetReference}.${input.run.milestoneStagingTableId}\`
        WHERE user_key IN UNNEST(@user_keys)
      `,
      params: { user_keys: input.userKeys },
    });
    return new Map(
      rows.map((row) => {
        const cohortWeek = stringFromBigQuery(row.cohort_week);
        const removedCount = integerFromBigQuery(row.removed_count);
        if (!cohortWeek || removedCount === null) {
          throw new InternalServerError({ debugMessage: "Malformed product analytics removed-key count" });
        }
        return [cohortWeek, removedCount];
      }),
    );
  }

  async validateAndPromote(input: {
    run: ProductAnalyticsExportRun;
    expectedMilestoneRows: number;
    expectedTotalAccounts: number;
    expectedEnabledAccounts: number;
    metadata: ProductAnalyticsExportRunMetadata;
  }): Promise<void> {
    const metadataCounts = [
      input.metadata.usersScanned,
      input.metadata.sourceSuppressedUsers,
      input.metadata.internalUsers,
      input.metadata.externalAccounts,
      input.metadata.enabledAccounts,
      input.metadata.optedOutAccounts,
      input.metadata.preferenceAfterCutoffAccounts,
      input.metadata.latePreferenceRowsRemoved,
      input.metadata.milestoneRowsPublished,
      input.metadata.cohortRowsPublished,
    ];
    if (
      input.metadata.runId !== input.run.runId ||
      input.metadata.enabledAccounts !== input.expectedEnabledAccounts ||
      input.metadata.externalAccounts !== input.expectedTotalAccounts ||
      input.metadata.milestoneRowsPublished !== input.expectedMilestoneRows ||
      metadataCounts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      [input.metadata.runCutoff, input.metadata.preferenceScanCutoff, input.metadata.controlUpdatedAt].some((value) =>
        Number.isNaN(value.getTime()),
      )
    ) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics export metadata" });
    }
    const validationRows = await this.#api.query({
      sql: `
        SELECT
          (SELECT COUNT(*) FROM \`${this.#api.datasetReference}.${input.run.milestoneStagingTableId}\`) AS milestone_rows,
          (SELECT COUNT(*) - COUNT(DISTINCT user_key) FROM \`${this.#api.datasetReference}.${input.run.milestoneStagingTableId}\`) AS duplicate_keys,
          (SELECT COUNTIF(NOT REGEXP_CONTAINS(user_key, r'^[a-f0-9]{64}$')) FROM \`${this.#api.datasetReference}.${input.run.milestoneStagingTableId}\`) AS invalid_keys,
          (SELECT COUNTIF(
            account_created_at > exported_at OR
            (notification_registered_at IS NOT NULL AND (notification_registered_at < account_created_at OR notification_registered_at > exported_at)) OR
            (bridge_registered_at IS NOT NULL AND (bridge_registered_at < account_created_at OR bridge_registered_at > exported_at)) OR
            (legacy_first_metadata_request_at IS NOT NULL AND (legacy_first_metadata_request_at < account_created_at OR legacy_first_metadata_request_at > exported_at))
          ) FROM \`${this.#api.datasetReference}.${input.run.milestoneStagingTableId}\`) AS invalid_timestamps,
          (SELECT COALESCE(SUM(total_accounts), 0) FROM \`${this.#api.datasetReference}.${input.run.cohortStagingTableId}\`) AS total_accounts,
          (SELECT COALESCE(SUM(enabled_accounts), 0) FROM \`${this.#api.datasetReference}.${input.run.cohortStagingTableId}\`) AS enabled_accounts,
          (SELECT COUNTIF(
            total_accounts < 0 OR enabled_accounts < 0 OR enabled_accounts > total_accounts OR
            notification_registered_within_1_day < 0 OR
            notification_registered_within_1_day > notification_registered_within_7_days OR
            notification_registered_within_7_days > notification_registered_within_30_days OR
            notification_registered_within_30_days > total_accounts OR
            bridge_registered_within_1_day < 0 OR
            bridge_registered_within_1_day > bridge_registered_within_7_days OR
            bridge_registered_within_7_days > bridge_registered_within_30_days OR
            bridge_registered_within_30_days > total_accounts OR
            legacy_first_metadata_request_within_1_day < 0 OR
            legacy_first_metadata_request_within_1_day > legacy_first_metadata_request_within_7_days OR
            legacy_first_metadata_request_within_7_days > legacy_first_metadata_request_within_30_days OR
            legacy_first_metadata_request_within_30_days > total_accounts
          ) FROM \`${this.#api.datasetReference}.${input.run.cohortStagingTableId}\`) AS invalid_cohorts
      `,
    });
    const row = validationRows[0];
    const values = row
      ? [
          row.milestone_rows,
          row.duplicate_keys,
          row.invalid_keys,
          row.invalid_timestamps,
          row.total_accounts,
          row.enabled_accounts,
          row.invalid_cohorts,
        ].map(integerFromBigQuery)
      : [];
    if (
      values.length !== 7 ||
      values.some((value) => value === null) ||
      values[0] !== input.expectedMilestoneRows ||
      values[1] !== 0 ||
      values[2] !== 0 ||
      values[3] !== 0 ||
      values[4] !== input.expectedTotalAccounts ||
      values[5] !== input.expectedEnabledAccounts ||
      values[6] !== 0
    ) {
      throw new InternalServerError({ debugMessage: "Product analytics export validation failed" });
    }

    await this.#api.query({
      sql: `
        BEGIN TRANSACTION;
        DELETE FROM \`${this.#api.datasetReference}.auth_user_milestones\` WHERE TRUE;
        INSERT INTO \`${this.#api.datasetReference}.auth_user_milestones\`
        SELECT * FROM \`${this.#api.datasetReference}.${input.run.milestoneStagingTableId}\`;
        DELETE FROM \`${this.#api.datasetReference}.auth_weekly_setup_cohorts\` WHERE TRUE;
        INSERT INTO \`${this.#api.datasetReference}.auth_weekly_setup_cohorts\`
        SELECT * FROM \`${this.#api.datasetReference}.${input.run.cohortStagingTableId}\`;
        INSERT INTO \`${this.#api.datasetReference}.product_analytics_export_runs\` (
          run_id,
          run_cutoff,
          preference_scan_cutoff,
          control_updated_at,
          users_scanned,
          source_suppressed_users,
          internal_users,
          external_accounts,
          enabled_accounts,
          opted_out_accounts,
          preference_after_cutoff_accounts,
          late_preference_rows_removed,
          milestone_rows_published,
          cohort_rows_published,
          published_at
        ) VALUES (
          @run_id,
          TIMESTAMP(@run_cutoff),
          TIMESTAMP(@preference_scan_cutoff),
          TIMESTAMP(@control_updated_at),
          @users_scanned,
          @source_suppressed_users,
          @internal_users,
          @external_accounts,
          @enabled_accounts,
          @opted_out_accounts,
          @preference_after_cutoff_accounts,
          @late_preference_rows_removed,
          @milestone_rows_published,
          @cohort_rows_published,
          CURRENT_TIMESTAMP()
        );
        COMMIT TRANSACTION;
      `,
      params: {
        run_id: input.metadata.runId,
        run_cutoff: input.metadata.runCutoff.toISOString(),
        preference_scan_cutoff: input.metadata.preferenceScanCutoff.toISOString(),
        control_updated_at: input.metadata.controlUpdatedAt.toISOString(),
        users_scanned: input.metadata.usersScanned,
        source_suppressed_users: input.metadata.sourceSuppressedUsers,
        internal_users: input.metadata.internalUsers,
        external_accounts: input.metadata.externalAccounts,
        enabled_accounts: input.metadata.enabledAccounts,
        opted_out_accounts: input.metadata.optedOutAccounts,
        preference_after_cutoff_accounts: input.metadata.preferenceAfterCutoffAccounts,
        late_preference_rows_removed: input.metadata.latePreferenceRowsRemoved,
        milestone_rows_published: input.metadata.milestoneRowsPublished,
        cohort_rows_published: input.metadata.cohortRowsPublished,
      },
    });
  }

  async cleanup(input: { run: ProductAnalyticsExportRun }): Promise<void> {
    const results = await Promise.allSettled([
      this.#api.deleteTable({ tableId: input.run.milestoneStagingTableId }),
      this.#api.deleteTable({ tableId: input.run.cohortStagingTableId }),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }
}

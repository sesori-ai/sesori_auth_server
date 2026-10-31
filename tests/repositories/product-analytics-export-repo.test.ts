import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InternalServerError } from "../../src/lib/errors.js";
import type { ProductAnalyticsExternalQueryRow } from "../../src/api/product-analytics-export-api.js";
import type {
  ProductAnalyticsDesktopEvent,
  ProductAnalyticsExportRow,
  ProductAnalyticsExportRunMetadata,
  ProductAnalyticsExportTableField,
  ProductAnalyticsSetupCohortRow,
} from "../../src/models/product-analytics-export.js";
import {
  ProductAnalyticsExportRepository,
  productAnalyticsPermanentTableSchemas,
} from "../../src/repositories/product-analytics-export-repo.js";
import { ProductAnalyticsEventName, ProductAnalyticsEventPlatform } from "../../src/types/product-analytics.js";

class FakeExportApi {
  readonly datasetReference = "valid-project.auth_private";
  readonly created: Array<{
    tableId: string;
    schema: ProductAnalyticsExportTableField[];
    expiresAt: Date | null;
    ifNotExists: boolean;
  }> = [];
  readonly queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  readonly deleted: string[] = [];
  invalidSchemaTableId: string | null = null;
  readonly schemaOverrides = new Map<string, ProductAnalyticsExportTableField[]>();
  readonly deleteFailures = new Set<string>();
  readonly missingTables = new Set<string>();
  readonly createFailures = new Set<string>();
  validationRow: ProductAnalyticsExternalQueryRow = {
    milestone_rows: 1,
    duplicate_keys: 0,
    invalid_keys: 0,
    invalid_timestamps: 0,
    total_accounts: 2,
    enabled_accounts: 1,
    invalid_cohorts: 0,
    desktop_event_rows: 1,
  };

  async createTable(input: {
    tableId: string;
    schema: ProductAnalyticsExportTableField[];
    expiresAt: Date | null;
    ifNotExists: boolean;
  }): Promise<void> {
    if (this.createFailures.has(input.tableId)) {
      throw new Error(`create failed: ${input.tableId}`);
    }
    this.created.push(input);
  }

  async getTableSchema(input: { tableId: string }): Promise<ProductAnalyticsExportTableField[]> {
    if (this.missingTables.has(input.tableId)) {
      throw new Error(`table not found: ${input.tableId}`);
    }
    if (input.tableId === this.invalidSchemaTableId) {
      return [];
    }
    return this.schemaOverrides.get(input.tableId) ?? productAnalyticsPermanentTableSchemas.get(input.tableId) ?? [];
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
    if (this.deleteFailures.has(input.tableId)) {
      throw new Error(`delete failed: ${input.tableId}`);
    }
  }
}

describe("ProductAnalyticsExportRepository", () => {
  const exportedAt = new Date("2026-07-28T12:00:00.000Z");
  const cleanupRun = {
    runId: "testrun01",
    milestoneStagingTableId: "auth_user_milestones_staging_testrun01",
    cohortStagingTableId: "auth_weekly_setup_cohorts_staging_testrun01",
    desktopEventStagingTableId: "desktop_product_events_staging_testrun01",
  };
  const desktopEventWindow = {
    start: new Date("2026-07-21T00:00:00.000Z"),
    end: new Date("2026-07-28T00:00:00.000Z"),
  };
  const desktopEvent: ProductAnalyticsDesktopEvent = {
    userKey: "c".repeat(64),
    eventName: ProductAnalyticsEventName.FeedbackPromptAnswered,
    occurredAtMicros: 1_785_000_000_000_123,
    receivedAt: new Date("2026-07-27T23:30:00.000Z"),
    schemaVersion: 1,
    platform: ProductAnalyticsEventPlatform.MacOs,
    appVersion: "1.2.3",
    params: { answer: "dismissed", source: "settings" },
  };
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
    preCreationMilestonesDropped: 0,
  };

  it("uses expiring run-scoped staging and query jobs rather than streaming inserts", async () => {
    const api = new FakeExportApi();
    const repo = new ProductAnalyticsExportRepository({ api });
    const expiresAt = new Date("2026-07-29T12:00:00.000Z");
    const run = await repo.beginRun({ runId: "testrun01", runCutoff: exportedAt, expiresAt });
    await repo.appendMilestones({ run, rows: [milestone] });
    await repo.writeCohorts({ run, rows: [cohort] });

    assert.equal(api.created.length, 3);
    assert.deepEqual(
      api.created.map((entry) => [entry.tableId, entry.ifNotExists, entry.expiresAt?.toISOString() ?? null]),
      [
        [run.milestoneStagingTableId, false, expiresAt.toISOString()],
        [run.cohortStagingTableId, false, expiresAt.toISOString()],
        [run.desktopEventStagingTableId, false, expiresAt.toISOString()],
      ],
    );
    const inserts = api.queries.filter((query) => query.sql.includes("INSERT INTO"));
    assert.equal(inserts.length, 2);
    assert.equal(String(inserts[0].params?.rows_json).includes(milestone.userKey), true);
    assert.equal(
      api.queries.some((query) => query.sql.includes("Another export is active")),
      true,
    );
  });

  it("removes late keys, validates reconciliation, and transactionally promotes both tables", async () => {
    const api = new FakeExportApi();
    const repo = new ProductAnalyticsExportRepository({ api });
    const run = await repo.beginRun({
      runId: "testrun01",
      runCutoff: exportedAt,
      expiresAt: new Date("2026-07-29T12:00:00.000Z"),
    });

    const removed = await repo.removeUserKeys({ run, userKeys: [milestone.userKey] });
    await repo.validateAndPromote({
      run,
      expectedMilestoneRows: 1,
      expectedTotalAccounts: 2,
      expectedEnabledAccounts: 1,
      expectedDesktopEventRows: 1,
      desktopEventWindow,
      metadata,
    });
    await repo.cleanup({ run });

    assert.deepEqual([...removed], [["2026-07-20", 1]]);
    assert.equal(
      api.queries.some((query) => query.sql.includes("DELETE FROM") && query.params?.user_keys),
      true,
    );
    const promotion = api.queries.find((query) => query.sql.includes("Export lease lost"));
    assert.ok(promotion);
    assert.match(promotion.sql, /auth_user_milestones/);
    assert.match(promotion.sql, /auth_weekly_setup_cohorts/);
    assert.match(promotion.sql, /product_analytics_export_runs/);
    assert.match(promotion.sql, /last_published_cutoff/);
    assert.equal(promotion.params?.run_id, "testrun01");
    assert.deepEqual(api.deleted, [
      run.milestoneStagingTableId,
      run.cohortStagingTableId,
      run.desktopEventStagingTableId,
    ]);
  });

  it("does not publish when staging reconciliation fails", async () => {
    const api = new FakeExportApi();
    api.validationRow.enabled_accounts = 2;
    const repo = new ProductAnalyticsExportRepository({ api });
    const run = await repo.beginRun({
      runId: "testrun01",
      runCutoff: exportedAt,
      expiresAt: new Date("2026-07-29T12:00:00.000Z"),
    });

    await assert.rejects(
      () =>
        repo.validateAndPromote({
          run,
          expectedMilestoneRows: 1,
          expectedTotalAccounts: 2,
          expectedEnabledAccounts: 1,
          expectedDesktopEventRows: 1,
          desktopEventWindow,
          metadata,
        }),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Product analytics export validation failed",
    );
    assert.equal(
      api.queries.some((query) => query.sql.includes("Export lease lost")),
      false,
    );
  });

  it("fails before leasing or staging when deployment-owned schemas drift", async () => {
    const api = new FakeExportApi();
    api.invalidSchemaTableId = "product_analytics_export_state";
    const repo = new ProductAnalyticsExportRepository({ api });

    await assert.rejects(
      () =>
        repo.beginRun({
          runId: "testrun01",
          runCutoff: exportedAt,
          expiresAt: new Date("2026-07-29T12:00:00.000Z"),
        }),
      (error: unknown) =>
        error instanceof InternalServerError &&
        error.debugMessage === "Unexpected product analytics schema for product_analytics_export_state",
    );
    assert.equal(api.created.length, 0);
    assert.equal(api.queries.length, 0);
  });

  it("accepts case-insensitive BigQuery field names when validating schemas", async () => {
    const api = new FakeExportApi();
    const stateSchema = productAnalyticsPermanentTableSchemas.get("product_analytics_export_state");
    assert.ok(stateSchema);
    api.schemaOverrides.set(
      "product_analytics_export_state",
      stateSchema.map((field) => ({
        ...field,
        name: field.name.toUpperCase(),
      })),
    );
    const repo = new ProductAnalyticsExportRepository({ api });

    await repo.beginRun({
      runId: "testrun01",
      runCutoff: exportedAt,
      expiresAt: new Date("2026-07-29T12:00:00.000Z"),
    });

    assert.equal(api.created.length, 3);
  });

  it("pins the desktop table's columns, in the order of the warehouse DDL", () => {
    const required = (name: string, type: string) => ({ name, type, mode: "REQUIRED" });
    const nullable = (name: string) => ({ name, type: "STRING", mode: "NULLABLE" });

    assert.deepEqual(productAnalyticsPermanentTableSchemas.get("desktop_product_events"), [
      required("event_name", "STRING"),
      required("source_export_date", "DATE"),
      required("received_at", "TIMESTAMP"),
      required("occurred_at_micros", "INTEGER"),
      required("schema_version", "INTEGER"),
      required("user_key", "STRING"),
      required("platform", "STRING"),
      required("app_version", "STRING"),
      nullable("activation_schema_version"),
      nullable("inventory_state"),
      nullable("activity_state"),
      nullable("submission_kind"),
      nullable("input_mode"),
      nullable("workspace_kind"),
      nullable("failure_reason"),
      nullable("decision"),
      nullable("change_state"),
      nullable("surface"),
      nullable("channel"),
      nullable("method"),
      nullable("os"),
      nullable("screen"),
      nullable("feedback_answer"),
      nullable("feedback_input"),
      nullable("feedback_source"),
    ]);
  });

  it("maps desktop events to warehouse columns with a UTC export date", async () => {
    const api = new FakeExportApi();
    const repo = new ProductAnalyticsExportRepository({ api });

    await repo.appendDesktopEvents({ run: cleanupRun, events: [] });
    assert.equal(api.queries.length, 0);

    await repo.appendDesktopEvents({
      run: cleanupRun,
      events: [
        desktopEvent,
        {
          ...desktopEvent,
          eventName: ProductAnalyticsEventName.PrivateFeedbackSent,
          // 23:30 UTC, already the next day at this offset.
          receivedAt: new Date("2026-07-28T01:30:00.000+02:00"),
          params: { input: "typed", source: "automatic" },
        },
        {
          ...desktopEvent,
          eventName: ProductAnalyticsEventName.SessionPermissionAnswered,
          params: { decision: "once" },
        },
      ],
    });

    const [query] = api.queries;
    assert.ok(query);
    assert.match(query.sql, new RegExp(`INSERT INTO \`[^\`]+\\.${cleanupRun.desktopEventStagingTableId}\``));
    assert.deepEqual(JSON.parse(String(query.params?.rows_json)), [
      {
        feedback_answer: "dismissed",
        feedback_source: "settings",
        event_name: "feedback_prompt_answered",
        source_export_date: "2026-07-27",
        received_at: "2026-07-27T23:30:00.000Z",
        occurred_at_micros: "1785000000000123",
        schema_version: 1,
        user_key: "c".repeat(64),
        platform: "MACOS",
        app_version: "1.2.3",
      },
      {
        feedback_input: "typed",
        feedback_source: "automatic",
        event_name: "private_feedback_sent",
        source_export_date: "2026-07-27",
        received_at: "2026-07-27T23:30:00.000Z",
        occurred_at_micros: "1785000000000123",
        schema_version: 1,
        user_key: "c".repeat(64),
        platform: "MACOS",
        app_version: "1.2.3",
      },
      {
        decision: "once",
        event_name: "session_permission_answered",
        source_export_date: "2026-07-27",
        received_at: "2026-07-27T23:30:00.000Z",
        occurred_at_micros: "1785000000000123",
        schema_version: 1,
        user_key: "c".repeat(64),
        platform: "MACOS",
        app_version: "1.2.3",
      },
    ]);
  });

  it("inserts every desktop column in schema order", async () => {
    const api = new FakeExportApi();
    const repo = new ProductAnalyticsExportRepository({ api });

    await repo.appendDesktopEvents({ run: cleanupRun, events: [desktopEvent] });

    const [query] = api.queries;
    assert.ok(query);
    const [columnList, selectList] = query.sql.split("SELECT");
    const columns = (productAnalyticsPermanentTableSchemas.get("desktop_product_events") ?? []).map(({ name }) => name);
    assert.equal(columns.length, 25);
    assert.deepEqual(
      columnList
        .split("(")[1]
        .split(")")[0]
        .split(",")
        .map((column) => column.trim()),
      columns,
    );
    assert.deepEqual(
      [...selectList.matchAll(/JSON_VALUE\(row, '\$\.(\w+)'\)/g)].map(([, column]) => column),
      columns,
    );
  });

  it("does not publish when the staged desktop row count differs", async () => {
    const api = new FakeExportApi();
    api.validationRow.desktop_event_rows = 2;
    const repo = new ProductAnalyticsExportRepository({ api });

    await assert.rejects(
      () =>
        repo.validateAndPromote({
          run: cleanupRun,
          expectedMilestoneRows: 1,
          expectedTotalAccounts: 2,
          expectedEnabledAccounts: 1,
          expectedDesktopEventRows: 1,
          desktopEventWindow,
          metadata,
        }),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Product analytics export validation failed",
    );
    assert.equal(
      api.queries.some((query) => query.sql.includes("Export lease lost")),
      false,
    );
  });

  it("replaces the window's desktop partitions in the promotion transaction on every run", async () => {
    const api = new FakeExportApi();
    const repo = new ProductAnalyticsExportRepository({ api });
    const promote = () =>
      repo.validateAndPromote({
        run: cleanupRun,
        expectedMilestoneRows: 1,
        expectedTotalAccounts: 2,
        expectedEnabledAccounts: 1,
        expectedDesktopEventRows: 1,
        desktopEventWindow,
        metadata,
      });

    await promote();
    await promote();

    const promotions = api.queries.filter((query) => query.sql.includes("Export lease lost"));
    assert.equal(promotions.length, 2);
    for (const promotion of promotions) {
      const deleteAt = promotion.sql.indexOf("DELETE FROM `valid-project.auth_private.desktop_product_events`");
      const insertAt = promotion.sql.indexOf("INSERT INTO `valid-project.auth_private.desktop_product_events`");
      assert.ok(promotion.sql.indexOf("BEGIN TRANSACTION") < deleteAt);
      assert.ok(deleteAt < insertAt);
      assert.ok(insertAt < promotion.sql.indexOf("COMMIT TRANSACTION"));
      assert.match(
        promotion.sql.slice(deleteAt, insertAt),
        /WHERE source_export_date >= CAST\(@desktop_window_start AS DATE\)\s+AND source_export_date < CAST\(@desktop_window_end AS DATE\);/,
      );
      assert.match(
        promotion.sql.slice(insertAt),
        new RegExp(`^INSERT INTO \\S+\\s+SELECT \\* FROM \`[^\`]+\\.${cleanupRun.desktopEventStagingTableId}\`;`),
      );
      assert.equal(promotion.params?.desktop_window_start, "2026-07-21");
      assert.equal(promotion.params?.desktop_window_end, "2026-07-28");
    }
  });

  it("fails before leasing or staging when the desktop table is missing or its columns moved", async () => {
    const missing = new FakeExportApi();
    missing.missingTables.add("desktop_product_events");
    const moved = new FakeExportApi();
    const [first, second, ...rest] = productAnalyticsPermanentTableSchemas.get("desktop_product_events") ?? [];
    moved.schemaOverrides.set("desktop_product_events", [second, first, ...rest]);

    for (const [api, expected] of [
      [missing, /table not found: desktop_product_events/],
      [moved, /internal_server_error/],
    ] as const) {
      await assert.rejects(
        () =>
          new ProductAnalyticsExportRepository({ api }).beginRun({
            runId: "testrun01",
            runCutoff: exportedAt,
            expiresAt: new Date("2026-07-29T12:00:00.000Z"),
          }),
        expected,
      );
      assert.equal(api.created.length, 0);
      assert.equal(api.queries.length, 0);
    }
  });

  it("removes the desktop staging table when creating it fails", async () => {
    const api = new FakeExportApi();
    api.createFailures.add(cleanupRun.desktopEventStagingTableId);

    await assert.rejects(
      () =>
        new ProductAnalyticsExportRepository({ api }).beginRun({
          runId: "testrun01",
          runCutoff: exportedAt,
          expiresAt: new Date("2026-07-29T12:00:00.000Z"),
        }),
      /create failed/,
    );

    assert.deepEqual(api.deleted, [
      cleanupRun.milestoneStagingTableId,
      cleanupRun.cohortStagingTableId,
      cleanupRun.desktopEventStagingTableId,
    ]);
  });

  it("reports every staging cleanup failure", async () => {
    const api = new FakeExportApi();
    const repo = new ProductAnalyticsExportRepository({ api });
    api.deleteFailures.add(cleanupRun.milestoneStagingTableId);
    api.deleteFailures.add(cleanupRun.cohortStagingTableId);
    api.deleteFailures.add(cleanupRun.desktopEventStagingTableId);

    await assert.rejects(
      () => repo.cleanup({ run: cleanupRun }),
      (error: unknown) => error instanceof AggregateError && error.errors.length === 3,
    );
  });

  it("rejects malformed run handles before interpolating staging table IDs", async () => {
    const api = new FakeExportApi();
    const repo = new ProductAnalyticsExportRepository({ api });

    await assert.rejects(
      () =>
        repo.appendMilestones({
          run: {
            runId: "testrun01",
            milestoneStagingTableId: "another_table",
            cohortStagingTableId: "auth_weekly_setup_cohorts_staging_testrun01",
            desktopEventStagingTableId: "desktop_product_events_staging_testrun01",
          },
          rows: [milestone],
        }),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Invalid product analytics export run",
    );
    assert.equal(api.queries.length, 0);
  });
});

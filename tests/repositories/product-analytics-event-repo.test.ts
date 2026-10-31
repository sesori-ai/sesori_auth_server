import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { inspect } from "node:util";
import { ObjectId, type Document } from "mongodb";
import type { ProductAnalyticsExternalQueryRow } from "../../src/api/product-analytics-export-api.js";
import { InternalServerError } from "../../src/lib/errors.js";
import type { ProductAnalyticsEvent } from "../../src/models/documents.js";
import { ProductAnalyticsEventRepository } from "../../src/repositories/product-analytics-event-repo.js";
import {
  ProductAnalyticsExportRepository,
  productAnalyticsPermanentTableSchemas,
} from "../../src/repositories/product-analytics-export-repo.js";
import { ProductAnalyticsExportService } from "../../src/services/product-analytics-export-service.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { ProductAnalyticsEventName, ProductAnalyticsEventPlatform } from "../../src/types/product-analytics.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

const dayMs = 24 * 60 * 60 * 1_000;

describe("Desktop product event export path", () => {
  let ctx: TestContext;
  // Relative to today, because the TTL monitor deletes rows older than 9 days while a test runs.
  const now = new Date();
  const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const windowStart = new Date(windowEnd.getTime() - 7 * dayMs);
  const justBeforeStart = new Date(windowStart.getTime() - 1);
  const justBeforeEnd = new Date(windowEnd.getTime() - 1);
  const midWindow = new Date(windowStart.getTime() + 3 * dayMs);

  before(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await eventCollection().deleteMany({});
  });

  after(async () => {
    await ctx.cleanup();
  });

  function eventCollection() {
    return ctx.dbAccessor.getCollection<ProductAnalyticsEvent>(
      MongoDbDatabase.Auth,
      AuthDbCollection.ProductAnalyticsEvents,
    );
  }

  async function storeEvents(input: { receivedAts: Date[] }): Promise<void> {
    await eventCollection().insertMany(
      input.receivedAts.map((receivedAt, index) => ({
        _id: new ObjectId(),
        userKey: "a".repeat(64),
        eventName: ProductAnalyticsEventName.FeedbackPromptAnswered,
        occurredAtMicros: receivedAt.getTime() * 1000 + index,
        receivedAt,
        schemaVersion: 1 as const,
        platform: ProductAnalyticsEventPlatform.Windows,
        appVersion: "1.2.3",
        params: { answer: "dismissed", source: "settings" },
      })),
    );
  }

  async function exportBatches(input: { batchLimit: number }) {
    const batches = [];
    const repo = new ProductAnalyticsEventRepository({ accessor: ctx.dbAccessor });
    for await (const batch of repo.findExportBatches({ start: windowStart, end: windowEnd, ...input })) {
      batches.push(batch);
    }
    return batches;
  }

  it("includes the window's start and excludes its end", async () => {
    await storeEvents({ receivedAts: [justBeforeStart, windowStart, midWindow, justBeforeEnd, windowEnd, now] });

    const rows = (await exportBatches({ batchLimit: 10 })).flat();

    assert.deepEqual(rows.map((row) => row.receivedAt.toISOString()).sort(), [
      windowStart.toISOString(),
      midWindow.toISOString(),
      justBeforeEnd.toISOString(),
    ]);
    assert.equal(
      rows.some((row) => "_id" in row),
      false,
    );
  });

  it("splits by the batch limit without an empty final batch", async () => {
    await storeEvents({ receivedAts: [windowStart, midWindow, justBeforeEnd] });

    assert.deepEqual(
      (await exportBatches({ batchLimit: 2 })).map((batch) => batch.length),
      [2, 1],
    );
    assert.deepEqual(
      (await exportBatches({ batchLimit: 3 })).map((batch) => batch.length),
      [3],
    );
  });

  it("fails closed on a malformed stored row without logging its values", async (t) => {
    const storedUserKey = "not-a-valid-key";
    // Zod doesn't echo a bad value, but a bad record entry's issue path does hold its key.
    const storedParamKey = "stored-param-key";
    await ctx.dbAccessor
      .getCollection<Document>(MongoDbDatabase.Auth, AuthDbCollection.ProductAnalyticsEvents)
      .insertOne({
        _id: new ObjectId(),
        userKey: storedUserKey,
        eventName: ProductAnalyticsEventName.SessionAbortSucceeded,
        occurredAtMicros: midWindow.getTime() * 1000,
        receivedAt: midWindow,
        schemaVersion: 1,
        platform: ProductAnalyticsEventPlatform.Windows,
        appVersion: "1.2.3",
        params: { [storedParamKey]: 1 },
      });
    const logged: unknown[][] = [];
    const consoleMethods: Array<"log" | "info" | "warn" | "error" | "debug"> = [
      "log",
      "info",
      "warn",
      "error",
      "debug",
    ];
    for (const method of consoleMethods) {
      t.mock.method(console, method, (...args: unknown[]) => {
        logged.push(args);
      });
    }

    await assert.rejects(
      () => exportBatches({ batchLimit: 2 }),
      (error: unknown) =>
        error instanceof InternalServerError &&
        error.debugMessage === "Malformed product analytics event" &&
        error.nestedError === undefined,
    );

    const output = inspect(logged, { depth: null });
    assert.equal(output.includes(storedUserKey), false);
    assert.equal(output.includes(storedParamKey), false);
  });

  it("publishes stored events through the whole run on a midday cutoff, and replaces them on a re-run", async () => {
    await storeEvents({ receivedAts: [justBeforeStart, windowStart, justBeforeEnd, windowEnd] });
    const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const created: string[] = [];
    const deleted: string[] = [];
    let clockNow = windowEnd;
    const service = new ProductAnalyticsExportService({
      userRepo: {
        findProductAnalyticsExportBatch: async () => [],
        findProductAnalyticsPreferenceChangeBatch: async () => [],
      },
      activationStateRepo: { findProductAnalyticsMilestonesByUserIds: async () => new Map() },
      controlRepo: {
        loadActiveInternalUserKeys: async () => ({
          userKeys: new Set<string>(),
          controlUpdatedAt: new Date(windowEnd.getTime() - dayMs),
        }),
      },
      exportRepo: new ProductAnalyticsExportRepository({
        api: {
          datasetReference: "valid-project.auth_private",
          createTable: async ({ tableId }) => {
            created.push(tableId);
          },
          getTableSchema: async ({ tableId }) => productAnalyticsPermanentTableSchemas.get(tableId) ?? [],
          query: async (input): Promise<ProductAnalyticsExternalQueryRow[]> => {
            queries.push(input);
            return input.sql.includes("AS milestone_rows")
              ? [
                  {
                    milestone_rows: 0,
                    duplicate_keys: 0,
                    invalid_keys: 0,
                    invalid_timestamps: 0,
                    total_accounts: 0,
                    enabled_accounts: 0,
                    invalid_cohorts: 0,
                    desktop_event_rows: 2,
                  },
                ]
              : [];
          },
          deleteTable: async ({ tableId }) => {
            deleted.push(tableId);
          },
        },
      }),
      eventRepo: new ProductAnalyticsEventRepository({ accessor: ctx.dbAccessor }),
      batchLimit: 10,
      pseudonymizationKey: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
      clock: () => clockNow,
      createRunId: () => "testrun01",
    });

    for (const hoursAfterMidnight of [3, 12]) {
      clockNow = new Date(windowEnd.getTime() + hoursAfterMidnight * 3_600_000);
      await service.run({ runCutoff: clockNow });
    }

    const stagingTable = "desktop_product_events_staging_testrun01";
    const appends = queries.filter((query) =>
      query.sql.includes(`INSERT INTO \`valid-project.auth_private.${stagingTable}`),
    );
    const promotions = queries.filter((query) => query.sql.includes("Export lease lost"));
    assert.equal(appends.length, 2);
    assert.equal(promotions.length, 2);
    for (const append of appends) {
      const rows: Array<{ source_export_date: string }> = JSON.parse(String(append.params?.rows_json));
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((row) => row.source_export_date).sort(),
        [windowStart, justBeforeEnd].map((date) => date.toISOString().slice(0, 10)),
      );
    }
    for (const promotion of promotions) {
      assert.equal(promotion.params?.desktop_window_start, windowStart.toISOString().slice(0, 10));
      assert.equal(promotion.params?.desktop_window_end, windowEnd.toISOString().slice(0, 10));
    }
    assert.equal(created.filter((tableId) => tableId === stagingTable).length, 2);
    assert.equal(deleted.filter((tableId) => tableId === stagingTable).length, 2);
  });
});

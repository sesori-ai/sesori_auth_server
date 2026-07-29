import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProductAnalyticsDeletionTargetApi } from "../../src/api/product-analytics-deletion-target-api.js";
import type { BigQueryProductAnalyticsDeletionTargetClient } from "../../src/clients/bigquery-product-analytics-deletion-target-client.js";
import { InternalServerError } from "../../src/lib/errors.js";
import {
  legacyFirebaseAnalyticsUserIdFor,
  productAnalyticsUserKeyFor,
} from "../../src/lib/product-analytics-user-key.js";
import { ProductAnalyticsDeletionTargetStatus } from "../../src/models/product-analytics-export.js";
import { ProductAnalyticsDeletionTargetRepository } from "../../src/repositories/product-analytics-deletion-target-repo.js";
import { ProductAnalyticsDeletionService } from "../../src/services/product-analytics-deletion-service.js";
import { ProductAnalyticsPreference } from "../../src/types/product-analytics.js";

describe("ProductAnalyticsDeletionService", () => {
  const userId = "000000000000000000000001";
  const requestId = "privacy_request_001";
  const suppressedAt = new Date("2026-07-28T12:00:00.000Z");
  const pseudonymizationKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
  const userKey = productAnalyticsUserKeyFor({ userId, pseudonymizationKey });
  const legacyFirebaseUserId = legacyFirebaseAnalyticsUserIdFor({ userId });

  it("source-tombstones before restricted handoff and returns no account key", async () => {
    const operations: string[] = [];
    const service = new ProductAnalyticsDeletionService({
      preferenceService: {
        async suppressExport() {
          operations.push("suppress");
          return {
            preference: {
              preference: ProductAnalyticsPreference.Disabled,
              updatedAt: suppressedAt,
              revision: 2,
            },
            suppressedAt,
            userKey,
            legacyFirebaseUserId,
          };
        },
      },
      deletionTargetRepo: {
        async handoff(input) {
          operations.push("handoff");
          assert.equal(input.userKey, userKey);
          assert.equal(input.legacyFirebaseUserId, legacyFirebaseUserId);
          assert.equal(input.suppressedAt.toISOString(), suppressedAt.toISOString());
          return { requestId: input.requestId, status: ProductAnalyticsDeletionTargetStatus.Pending };
        },
      },
      clock: () => suppressedAt,
    });

    const result = await service.suppressAndHandoff({ userId, requestId });

    assert.deepEqual(operations, ["suppress", "handoff"]);
    assert.deepEqual(result, { requestId, status: ProductAnalyticsDeletionTargetStatus.Pending });
    assert.equal(Object.hasOwn(result, "userKey"), false);
    assert.equal(Object.hasOwn(result, "legacyFirebaseUserId"), false);
  });

  it("keeps the source tombstone observable and retryable when target handoff fails", async () => {
    let suppressions = 0;
    const service = new ProductAnalyticsDeletionService({
      preferenceService: {
        async suppressExport() {
          suppressions += 1;
          return {
            preference: {
              preference: ProductAnalyticsPreference.Disabled,
              updatedAt: suppressedAt,
              revision: 2,
            },
            suppressedAt,
            userKey,
            legacyFirebaseUserId,
          };
        },
      },
      deletionTargetRepo: {
        async handoff() {
          throw new Error("target unavailable");
        },
      },
      clock: () => suppressedAt,
    });

    await assert.rejects(() => service.suppressAndHandoff({ userId, requestId }), /target unavailable/);
    assert.equal(suppressions, 1);
  });
});

describe("ProductAnalyticsDeletionTargetRepository", () => {
  const target = {
    requestId: "privacy_request_001",
    userKey: "a".repeat(64),
    legacyFirebaseUserId: "b".repeat(64),
    suppressedAt: new Date("2026-07-28T12:00:00.000Z"),
    status: ProductAnalyticsDeletionTargetStatus.Pending,
  };

  it("idempotently returns an existing matching handoff", async () => {
    let writes = 0;
    const repo = new ProductAnalyticsDeletionTargetRepository({
      api: {
        async findByRequestId() {
          return target;
        },
        async upsert() {
          writes += 1;
        },
      },
    });

    assert.deepEqual(await repo.handoff(target), target);
    assert.equal(writes, 0);
  });

  it("rejects request ID reuse for a different account key", async () => {
    const repo = new ProductAnalyticsDeletionTargetRepository({
      api: {
        async findByRequestId() {
          return target;
        },
        async upsert() {},
      },
    });

    await assert.rejects(
      () => repo.handoff({ ...target, userKey: "b".repeat(64) }),
      (error: unknown) =>
        error instanceof InternalServerError &&
        error.debugMessage === "Product analytics deletion request ID collision",
    );
  });

  it("rejects request ID reuse for a different tombstone timestamp", async () => {
    const repo = new ProductAnalyticsDeletionTargetRepository({
      api: {
        async findByRequestId() {
          return target;
        },
        async upsert() {},
      },
    });

    await assert.rejects(
      () => repo.handoff({ ...target, suppressedAt: new Date("2026-07-28T13:00:00.000Z") }),
      (error: unknown) =>
        error instanceof InternalServerError &&
        error.debugMessage === "Product analytics deletion request ID collision",
    );
  });

  it("rejects request ID reuse for a different legacy deletion ID", async () => {
    const repo = new ProductAnalyticsDeletionTargetRepository({
      api: {
        async findByRequestId() {
          return target;
        },
        async upsert() {},
      },
    });

    await assert.rejects(
      () => repo.handoff({ ...target, legacyFirebaseUserId: "c".repeat(64) }),
      (error: unknown) =>
        error instanceof InternalServerError &&
        error.debugMessage === "Product analytics deletion request ID collision",
    );
  });

  it("loads deletion status and rejects malformed request IDs", async () => {
    const repo = new ProductAnalyticsDeletionTargetRepository({
      api: {
        async findByRequestId() {
          return target;
        },
        async upsert() {},
      },
    });

    assert.equal(await repo.findStatus({ requestId: target.requestId }), ProductAnalyticsDeletionTargetStatus.Pending);
    await assert.rejects(
      () => repo.findStatus({ requestId: "invalid" }),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Invalid product analytics deletion request ID",
    );
  });

  it("rejects a concurrent handoff committed with a different tombstone timestamp", async () => {
    let reads = 0;
    const repo = new ProductAnalyticsDeletionTargetRepository({
      api: {
        async findByRequestId() {
          reads += 1;
          return reads === 1 ? null : { ...target, suppressedAt: new Date("2026-07-28T13:00:00.000Z") };
        },
        async upsert() {},
      },
    });

    await assert.rejects(
      () => repo.handoff(target),
      (error: unknown) =>
        error instanceof InternalServerError &&
        error.debugMessage === "Product analytics deletion target handoff failed",
    );
  });
});

describe("ProductAnalyticsDeletionTargetApi", () => {
  it("round-trips the HMAC and deletion-only legacy IDs", async () => {
    const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const client = {
      targetTableReference: "valid-project.privacy_private.product_analytics_deletion_targets",
      async query(input: { sql: string; params?: Record<string, unknown> }) {
        queries.push(input);
        if (input.sql.includes("SELECT request_id")) {
          return [
            {
              request_id: "privacy_request_001",
              user_key: "a".repeat(64),
              legacy_firebase_user_id: "b".repeat(64),
              suppressed_at: "2026-07-28T12:00:00.000Z",
              status: ProductAnalyticsDeletionTargetStatus.Pending,
            },
          ];
        }
        return [];
      },
    } as unknown as BigQueryProductAnalyticsDeletionTargetClient;
    const api = new ProductAnalyticsDeletionTargetApi({ client });
    const target = await api.findByRequestId({ requestId: "privacy_request_001" });

    assert.ok(target);
    assert.equal(target.legacyFirebaseUserId, "b".repeat(64));
    await api.upsert({ target });
    assert.equal(queries[1].params?.user_key, "a".repeat(64));
    assert.equal(queries[1].params?.legacy_firebase_user_id, "b".repeat(64));
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InternalServerError } from "../../src/lib/errors.js";
import { productAnalyticsUserKeyFor } from "../../src/lib/product-analytics-user-key.js";
import { ProductAnalyticsDeletionTargetStatus } from "../../src/models/product-analytics-export.js";
import { ProductAnalyticsDeletionTargetRepository } from "../../src/repositories/product-analytics-deletion-target-repo.js";
import { ProductAnalyticsDeletionService } from "../../src/services/product-analytics-deletion-service.js";
import { ProductAnalyticsPreference } from "../../src/types/product-analytics.js";

describe("ProductAnalyticsDeletionService", () => {
  const userId = "000000000000000000000001";
  const requestId = "privacy_request_001";
  const suppressedAt = new Date("2026-07-28T12:00:00.000Z");

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
          };
        },
      },
      deletionTargetRepo: {
        async handoff(input) {
          operations.push("handoff");
          assert.equal(input.userKey, productAnalyticsUserKeyFor({ userId }));
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
});

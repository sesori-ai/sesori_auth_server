import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InternalServerError } from "../../src/lib/errors.js";
import { ProductAnalyticsControlRepository } from "../../src/repositories/product-analytics-control-repo.js";

describe("ProductAnalyticsControlRepository", () => {
  const loadedAt = new Date("2026-07-28T12:00:00.000Z");
  const controlUpdatedAt = new Date("2026-07-28T11:00:00.000Z");
  const key = "a".repeat(64);

  it("loads a bounded fresh key set with a nullable empty-set sentinel", async () => {
    let requestedMaxRows: number | null = null;
    const repo = new ProductAnalyticsControlRepository({
      api: {
        async loadActiveInternalUserKeys(input) {
          requestedMaxRows = input.maxRows;
          return [
            { userKey: null, controlUpdatedAt },
            { userKey: key, controlUpdatedAt },
          ];
        },
      },
      maxUserKeys: 10,
      maxAgeMs: 2 * 60 * 60 * 1_000,
    });

    const snapshot = await repo.loadActiveInternalUserKeys({ loadedAt });

    assert.deepEqual([...snapshot.userKeys], [key]);
    assert.equal(snapshot.controlUpdatedAt.toISOString(), controlUpdatedAt.toISOString());
    assert.equal(requestedMaxRows, 12);
  });

  it("fails closed for missing, stale, malformed, duplicate, or oversized controls", async () => {
    const invalidRows = [
      [],
      [{ userKey: key, controlUpdatedAt: new Date("2026-07-28T09:00:00.000Z") }],
      [{ userKey: "invalid", controlUpdatedAt }],
      [{ userKey: key, controlUpdatedAt }],
      [
        { userKey: null, controlUpdatedAt },
        { userKey: null, controlUpdatedAt },
      ],
      [
        { userKey: null, controlUpdatedAt },
        { userKey: key, controlUpdatedAt },
        { userKey: key, controlUpdatedAt },
      ],
      [
        { userKey: null, controlUpdatedAt },
        { userKey: key, controlUpdatedAt },
        { userKey: "b".repeat(64), controlUpdatedAt },
      ],
    ];

    for (const rows of invalidRows) {
      const repo = new ProductAnalyticsControlRepository({
        api: {
          async loadActiveInternalUserKeys() {
            return rows;
          },
        },
        maxUserKeys: 1,
        maxAgeMs: 2 * 60 * 60 * 1_000,
      });
      await assert.rejects(
        () => repo.loadActiveInternalUserKeys({ loadedAt }),
        (error: unknown) => error instanceof InternalServerError,
      );
    }
  });
});

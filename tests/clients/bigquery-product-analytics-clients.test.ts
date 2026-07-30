import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BigQuery } from "@google-cloud/bigquery";
import { BigQueryProductAnalyticsDeletionTargetClient } from "../../src/clients/bigquery-product-analytics-deletion-target-client.js";
import { BigQueryProductAnalyticsClient } from "../../src/clients/bigquery-product-analytics-client.js";
import { InternalServerError } from "../../src/lib/errors.js";

describe("product analytics BigQuery clients", () => {
  const longProjectId = "a".repeat(31);

  it("rejects GCP project IDs longer than the platform limit", () => {
    const bigQuery = {} as BigQuery;

    assert.throws(
      () =>
        new BigQueryProductAnalyticsClient({
          bigQuery,
          projectId: longProjectId,
          datasetId: "auth_private",
          internalExclusionView: `${longProjectId}.controls.active_internal_users`,
          location: "europe-west1",
        }),
      (error: unknown) => error instanceof InternalServerError,
    );
    assert.throws(
      () =>
        new BigQueryProductAnalyticsDeletionTargetClient({
          bigQuery,
          projectId: longProjectId,
          datasetId: "privacy_private",
          location: "europe-west1",
        }),
      (error: unknown) => error instanceof InternalServerError,
    );
  });

  it("normalizes locations before sending BigQuery operations", async () => {
    const locations: unknown[] = [];
    const bigQuery = {
      async query(input: { location?: string }) {
        locations.push(input.location);
        return [[]];
      },
    } as unknown as BigQuery;
    const exportClient = new BigQueryProductAnalyticsClient({
      bigQuery,
      projectId: "valid-project",
      datasetId: "auth_private",
      internalExclusionView: "valid-project.controls.active_internal_users",
      location: "  europe-west1  ",
    });
    const deletionClient = new BigQueryProductAnalyticsDeletionTargetClient({
      bigQuery,
      projectId: "valid-project",
      datasetId: "privacy_private",
      location: "  europe-west1  ",
    });

    await exportClient.query({ sql: "SELECT 1" });
    await deletionClient.query({ sql: "SELECT 1" });

    assert.deepEqual(locations, ["europe-west1", "europe-west1"]);
  });

  it("bounds the internal-exclusion query before BigQuery materializes rows", async () => {
    const queries: Array<{ query: string; params?: Record<string, unknown> }> = [];
    const bigQuery = {
      async query(input: { query: string; params?: Record<string, unknown> }) {
        queries.push(input);
        return [[]];
      },
    } as unknown as BigQuery;
    const client = new BigQueryProductAnalyticsClient({
      bigQuery,
      projectId: "valid-project",
      datasetId: "auth_private",
      internalExclusionView: "valid-project.controls.active_internal_users",
      location: "europe-west1",
    });

    await client.loadActiveInternalUserKeys({ maxRows: 12 });

    assert.match(queries[0].query, /LIMIT @max_rows/);
    assert.equal(queries[0].params?.max_rows, 12);
  });
});

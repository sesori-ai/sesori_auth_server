import type { BigQueryProductAnalyticsDeletionTargetClient } from "../clients/bigquery-product-analytics-deletion-target-client.js";
import { InternalServerError } from "../lib/errors.js";
import {
  ProductAnalyticsDeletionTargetStatus,
  type ProductAnalyticsDeletionTarget,
} from "../models/product-analytics-export.js";

function dateFromBigQuery(input: unknown): Date | null {
  const value =
    typeof input === "object" && input !== null && "value" in input ? (input as { value: unknown }).value : input;
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class ProductAnalyticsDeletionTargetApi {
  readonly #client: BigQueryProductAnalyticsDeletionTargetClient;

  constructor(deps: { client: BigQueryProductAnalyticsDeletionTargetClient }) {
    this.#client = deps.client;
  }

  async findByRequestId(input: { requestId: string }): Promise<ProductAnalyticsDeletionTarget | null> {
    const rows = await this.#query({
      sql: `
        SELECT request_id, user_key, suppressed_at, status
        FROM \`${this.#client.targetTableReference}\`
        WHERE request_id = @request_id
        LIMIT 1
      `,
      params: { request_id: input.requestId },
    });
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    const suppressedAt = dateFromBigQuery(row.suppressed_at);
    const status = Object.values(ProductAnalyticsDeletionTargetStatus).find((value) => value === row.status);
    if (typeof row.request_id !== "string" || typeof row.user_key !== "string" || !suppressedAt || !status) {
      throw new InternalServerError({ debugMessage: "Malformed product analytics deletion target" });
    }
    return {
      requestId: row.request_id,
      userKey: row.user_key,
      suppressedAt,
      status,
    };
  }

  async upsert(input: { target: ProductAnalyticsDeletionTarget }): Promise<void> {
    await this.#query({
      sql: `
        MERGE \`${this.#client.targetTableReference}\` AS target
        USING (
          SELECT
            @request_id AS request_id,
            @user_key AS user_key,
            TIMESTAMP(@suppressed_at) AS suppressed_at,
            @status AS status
        ) AS source
        ON target.request_id = source.request_id
        WHEN NOT MATCHED THEN
          INSERT (request_id, user_key, suppressed_at, status, created_at, updated_at)
          VALUES (source.request_id, source.user_key, source.suppressed_at, source.status, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())
      `,
      params: {
        request_id: input.target.requestId,
        user_key: input.target.userKey,
        suppressed_at: input.target.suppressedAt.toISOString(),
        status: input.target.status,
      },
    });
  }

  async #query(input: { sql: string; params?: Record<string, unknown> }): Promise<Record<string, unknown>[]> {
    try {
      return await this.#client.query(input);
    } catch (error) {
      if (error instanceof InternalServerError) {
        throw error;
      }
      throw new InternalServerError({
        debugMessage: "Product analytics deletion-target BigQuery operation failed",
        nestedError: error,
      });
    }
  }
}

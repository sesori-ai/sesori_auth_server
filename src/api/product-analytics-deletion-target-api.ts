import type { BigQueryProductAnalyticsDeletionTargetClient } from "../clients/bigquery-product-analytics-deletion-target-client.js";
import { dateFromBigQuery } from "../lib/bigquery-values.js";
import { InternalServerError } from "../lib/errors.js";
import {
  ProductAnalyticsDeletionTargetStatus,
  type ProductAnalyticsDeletionTarget,
} from "../models/product-analytics-export.js";
import { productAnalyticsUserKeySchema } from "../types/product-analytics.js";

export class ProductAnalyticsDeletionTargetApi {
  readonly #client: BigQueryProductAnalyticsDeletionTargetClient;

  constructor(deps: { client: BigQueryProductAnalyticsDeletionTargetClient }) {
    this.#client = deps.client;
  }

  async findByRequestId(input: { requestId: string }): Promise<ProductAnalyticsDeletionTarget | null> {
    const rows = await this.#query({
      sql: `
        SELECT request_id, user_key, legacy_firebase_user_id, suppressed_at, status
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
    const suppressedAt = dateFromBigQuery({ value: row.suppressed_at });
    const status = Object.values(ProductAnalyticsDeletionTargetStatus).find((value) => value === row.status);
    const userKeyResult = productAnalyticsUserKeySchema.safeParse(row.user_key);
    const legacyFirebaseUserIdResult = productAnalyticsUserKeySchema.safeParse(row.legacy_firebase_user_id);
    if (
      typeof row.request_id !== "string" ||
      !userKeyResult.success ||
      !legacyFirebaseUserIdResult.success ||
      !suppressedAt ||
      !status
    ) {
      throw new InternalServerError({ debugMessage: "Malformed product analytics deletion target" });
    }
    return {
      requestId: row.request_id,
      userKey: userKeyResult.data,
      legacyFirebaseUserId: legacyFirebaseUserIdResult.data,
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
            @legacy_firebase_user_id AS legacy_firebase_user_id,
            TIMESTAMP(@suppressed_at) AS suppressed_at,
            @status AS status
        ) AS source
        ON target.request_id = source.request_id
        WHEN NOT MATCHED THEN
          INSERT (request_id, user_key, legacy_firebase_user_id, suppressed_at, status, created_at, updated_at)
          VALUES (source.request_id, source.user_key, source.legacy_firebase_user_id, source.suppressed_at, source.status, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())
      `,
      params: {
        request_id: input.target.requestId,
        user_key: input.target.userKey,
        legacy_firebase_user_id: input.target.legacyFirebaseUserId,
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

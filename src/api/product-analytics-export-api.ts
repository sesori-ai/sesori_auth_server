import type { TableField } from "@google-cloud/bigquery";
import type { BigQueryProductAnalyticsClient } from "../clients/bigquery-product-analytics-client.js";
import { InternalServerError } from "../lib/errors.js";

export type ProductAnalyticsInternalExclusionRow = {
  userKey: string | null;
  controlUpdatedAt: Date;
};

export type ProductAnalyticsExternalQueryRow = Record<string, unknown>;

function dateFromBigQuery(input: unknown): Date | null {
  const value =
    typeof input === "object" && input !== null && "value" in input ? (input as { value: unknown }).value : input;
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class ProductAnalyticsExportApi {
  readonly #client: BigQueryProductAnalyticsClient;

  constructor(deps: { client: BigQueryProductAnalyticsClient }) {
    this.#client = deps.client;
  }

  get datasetReference(): string {
    return this.#client.datasetReference;
  }

  async createTable(input: {
    tableId: string;
    schema: TableField[];
    expiresAt: Date | null;
    ifNotExists: boolean;
  }): Promise<void> {
    await this.#wrap({ operation: "create table", run: () => this.#client.createTable(input) });
  }

  async getTableSchema(input: { tableId: string }): Promise<TableField[]> {
    return this.#wrap({ operation: "get table schema", run: () => this.#client.getTableSchema(input) });
  }

  async query(input: { sql: string; params?: Record<string, unknown> }): Promise<ProductAnalyticsExternalQueryRow[]> {
    return this.#wrap({ operation: "query", run: () => this.#client.query(input) });
  }

  async deleteTable(input: { tableId: string }): Promise<void> {
    await this.#wrap({ operation: "delete table", run: () => this.#client.deleteTable(input) });
  }

  async loadActiveInternalUserKeys(): Promise<ProductAnalyticsInternalExclusionRow[]> {
    const rows = await this.#wrap({
      operation: "load internal exclusions",
      run: () => this.#client.loadActiveInternalUserKeys(),
    });
    return rows.map((row) => {
      const userKey = row.user_key;
      const controlUpdatedAt = dateFromBigQuery(row.control_updated_at);
      if ((userKey !== null && typeof userKey !== "string") || !controlUpdatedAt) {
        throw new InternalServerError({ debugMessage: "Malformed product analytics internal-exclusion row" });
      }
      return { userKey, controlUpdatedAt };
    });
  }

  async #wrap<T>(input: { operation: string; run: () => Promise<T> }): Promise<T> {
    try {
      return await input.run();
    } catch (error) {
      if (error instanceof InternalServerError) {
        throw error;
      }
      throw new InternalServerError({
        debugMessage: `Product analytics BigQuery ${input.operation} failed`,
        nestedError: error,
      });
    }
  }
}

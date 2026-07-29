import type { BigQueryProductAnalyticsClient } from "../clients/bigquery-product-analytics-client.js";
import { dateFromBigQuery } from "../lib/bigquery-values.js";
import { InternalServerError } from "../lib/errors.js";
import type {
  ProductAnalyticsExportTableField,
  ProductAnalyticsInternalExclusionRow,
} from "../models/product-analytics-export.js";

export type ProductAnalyticsExternalQueryRow = Record<string, unknown>;

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
    schema: ProductAnalyticsExportTableField[];
    expiresAt: Date | null;
    ifNotExists: boolean;
  }): Promise<void> {
    await this.#wrap({ operation: "create table", run: () => this.#client.createTable(input) });
  }

  async getTableSchema(input: { tableId: string }): Promise<ProductAnalyticsExportTableField[]> {
    return this.#wrap({ operation: "get table schema", run: () => this.#client.getTableSchema(input) });
  }

  async query(input: { sql: string; params?: Record<string, unknown> }): Promise<ProductAnalyticsExternalQueryRow[]> {
    return this.#wrap({ operation: "query", run: () => this.#client.query(input) });
  }

  async deleteTable(input: { tableId: string }): Promise<void> {
    await this.#wrap({ operation: "delete table", run: () => this.#client.deleteTable(input) });
  }

  async loadActiveInternalUserKeys(input: { maxRows: number }): Promise<ProductAnalyticsInternalExclusionRow[]> {
    const rows = await this.#wrap({
      operation: "load internal exclusions",
      run: () => this.#client.loadActiveInternalUserKeys(input),
    });
    return rows.map((row) => {
      const userKey = row.user_key;
      const controlUpdatedAt = dateFromBigQuery({ value: row.control_updated_at });
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

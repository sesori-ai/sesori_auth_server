import { BigQuery, type TableField } from "@google-cloud/bigquery";
import { InternalServerError } from "../lib/errors.js";
import type { ProductAnalyticsExportTableField } from "../models/product-analytics-export.js";

const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const datasetOrTableIdPattern = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const qualifiedViewPattern =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/;

export type ProductAnalyticsBigQueryRow = Record<string, unknown>;

export class BigQueryProductAnalyticsClient {
  readonly #bigQuery: BigQuery;
  readonly #projectId: string;
  readonly #datasetId: string;
  readonly #internalExclusionView: string;
  readonly #location: string;

  constructor(deps: {
    bigQuery: BigQuery;
    projectId: string;
    datasetId: string;
    internalExclusionView: string;
    location: string;
  }) {
    if (
      !projectIdPattern.test(deps.projectId) ||
      !datasetOrTableIdPattern.test(deps.datasetId) ||
      !qualifiedViewPattern.test(deps.internalExclusionView) ||
      deps.location.trim() === ""
    ) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics BigQuery client configuration" });
    }
    this.#bigQuery = deps.bigQuery;
    this.#projectId = deps.projectId;
    this.#datasetId = deps.datasetId;
    this.#internalExclusionView = deps.internalExclusionView;
    this.#location = deps.location.trim();
  }

  get datasetReference(): string {
    return `${this.#projectId}.${this.#datasetId}`;
  }

  async createTable(input: {
    tableId: string;
    schema: ProductAnalyticsExportTableField[];
    expiresAt: Date | null;
    ifNotExists: boolean;
  }): Promise<void> {
    this.#assertTableId(input.tableId);
    if (input.expiresAt && Number.isNaN(input.expiresAt.getTime())) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics table expiration" });
    }

    const dataset = this.#bigQuery.dataset(this.#datasetId, {
      projectId: this.#projectId,
      location: this.#location,
    });
    const table = dataset.table(input.tableId);
    if (input.ifNotExists) {
      const [exists] = await table.exists();
      if (exists) {
        return;
      }
    }
    await dataset.createTable(input.tableId, {
      schema: input.schema.map(
        (field): TableField => ({
          name: field.name,
          type: field.type,
          ...(field.mode === undefined ? {} : { mode: field.mode }),
        }),
      ),
      ...(input.expiresAt ? { expirationTime: input.expiresAt.getTime().toString() } : {}),
    });
  }

  async getTableSchema(input: { tableId: string }): Promise<ProductAnalyticsExportTableField[]> {
    this.#assertTableId(input.tableId);
    const [metadata] = await this.#bigQuery
      .dataset(this.#datasetId, { projectId: this.#projectId, location: this.#location })
      .table(input.tableId)
      .getMetadata();
    return (metadata.schema?.fields ?? []).map((field: TableField) => ({
      name: field.name ?? "",
      type: field.type ?? "",
      ...(field.mode === undefined ? {} : { mode: field.mode }),
    }));
  }

  async query(input: { sql: string; params?: Record<string, unknown> }): Promise<ProductAnalyticsBigQueryRow[]> {
    const [rows] = await this.#bigQuery.query({
      query: input.sql,
      location: this.#location,
      params: input.params,
      useLegacySql: false,
    });
    return rows as ProductAnalyticsBigQueryRow[];
  }

  async deleteTable(input: { tableId: string }): Promise<void> {
    this.#assertTableId(input.tableId);
    await this.#bigQuery
      .dataset(this.#datasetId, { projectId: this.#projectId, location: this.#location })
      .table(input.tableId)
      .delete({ ignoreNotFound: true });
  }

  async loadActiveInternalUserKeys(input: { maxRows: number }): Promise<ProductAnalyticsBigQueryRow[]> {
    if (!Number.isSafeInteger(input.maxRows) || input.maxRows < 1 || input.maxRows > 100_002) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics internal-exclusion row limit" });
    }
    const [rows] = await this.#bigQuery.query({
      query: `
        SELECT user_key, control_updated_at
        FROM \`${this.#internalExclusionView}\`
        WHERE is_active = TRUE OR user_key IS NULL
        LIMIT @max_rows
      `,
      location: this.#location,
      params: { max_rows: input.maxRows },
      useLegacySql: false,
    });
    return rows as ProductAnalyticsBigQueryRow[];
  }

  #assertTableId(tableId: string): void {
    if (!datasetOrTableIdPattern.test(tableId)) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics BigQuery table ID" });
    }
  }
}

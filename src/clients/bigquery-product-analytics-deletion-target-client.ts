import { BigQuery } from "@google-cloud/bigquery";
import { InternalServerError } from "../lib/errors.js";

export type ProductAnalyticsDeletionTargetBigQueryRow = Record<string, unknown>;

const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const datasetIdPattern = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;

export class BigQueryProductAnalyticsDeletionTargetClient {
  readonly #bigQuery: BigQuery;
  readonly #projectId: string;
  readonly #datasetId: string;
  readonly #location: string;

  constructor(deps: { bigQuery: BigQuery; projectId: string; datasetId: string; location: string }) {
    if (
      !projectIdPattern.test(deps.projectId) ||
      !datasetIdPattern.test(deps.datasetId) ||
      deps.location.trim() === ""
    ) {
      throw new InternalServerError({
        debugMessage: "Invalid product analytics deletion-target BigQuery client configuration",
      });
    }
    this.#bigQuery = deps.bigQuery;
    this.#projectId = deps.projectId;
    this.#datasetId = deps.datasetId;
    this.#location = deps.location.trim();
  }

  async query(input: {
    sql: string;
    params?: Record<string, unknown>;
  }): Promise<ProductAnalyticsDeletionTargetBigQueryRow[]> {
    const [rows] = await this.#bigQuery.query({
      query: input.sql,
      location: this.#location,
      params: input.params,
      useLegacySql: false,
    });
    return rows as ProductAnalyticsDeletionTargetBigQueryRow[];
  }

  get targetTableReference(): string {
    return `${this.#projectId}.${this.#datasetId}.product_analytics_deletion_targets`;
  }
}

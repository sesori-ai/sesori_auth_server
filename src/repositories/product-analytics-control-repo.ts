import type { ProductAnalyticsInternalExclusionRow } from "../api/product-analytics-export-api.js";
import { InternalServerError } from "../lib/errors.js";

const userKeyPattern = /^[a-f0-9]{64}$/;

export type ProductAnalyticsInternalExclusionSnapshot = {
  userKeys: Set<string>;
  controlUpdatedAt: Date;
};

type ProductAnalyticsControlApi = {
  loadActiveInternalUserKeys(input: { maxRows: number }): Promise<ProductAnalyticsInternalExclusionRow[]>;
};

export class ProductAnalyticsControlRepository {
  readonly #api: ProductAnalyticsControlApi;
  readonly #maxUserKeys: number;
  readonly #maxAgeMs: number;

  constructor(deps: { api: ProductAnalyticsControlApi; maxUserKeys: number; maxAgeMs: number }) {
    if (
      !Number.isSafeInteger(deps.maxUserKeys) ||
      deps.maxUserKeys < 1 ||
      !Number.isSafeInteger(deps.maxAgeMs) ||
      deps.maxAgeMs < 1
    ) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics control limits" });
    }
    this.#api = deps.api;
    this.#maxUserKeys = deps.maxUserKeys;
    this.#maxAgeMs = deps.maxAgeMs;
  }

  async loadActiveInternalUserKeys(input: { loadedAt: Date }): Promise<ProductAnalyticsInternalExclusionSnapshot> {
    if (Number.isNaN(input.loadedAt.getTime())) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics control load time" });
    }
    // Include one sentinel and one overflow row so an oversized control cannot
    // be truncated into an apparently valid result.
    const rows = await this.#api.loadActiveInternalUserKeys({ maxRows: this.#maxUserKeys + 2 });
    this.#validateRows({ rows, loadedAt: input.loadedAt });

    return {
      userKeys: new Set(rows.flatMap((row) => (row.userKey === null ? [] : [row.userKey]))),
      controlUpdatedAt: rows[0].controlUpdatedAt,
    };
  }

  #validateRows(input: { rows: ProductAnalyticsInternalExclusionRow[]; loadedAt: Date }): void {
    if (input.rows.length === 0) {
      throw new InternalServerError({ debugMessage: "Product analytics internal-exclusion control is missing" });
    }
    const controlUpdatedAt = input.rows[0].controlUpdatedAt;
    const userKeys = input.rows.flatMap((row) => (row.userKey === null ? [] : [row.userKey]));
    const sentinelCount = input.rows.filter((row) => row.userKey === null).length;
    if (
      sentinelCount !== 1 ||
      input.rows.length > this.#maxUserKeys + 1 ||
      userKeys.length > this.#maxUserKeys ||
      userKeys.some((userKey) => !userKeyPattern.test(userKey)) ||
      new Set(userKeys).size !== userKeys.length ||
      Number.isNaN(controlUpdatedAt.getTime()) ||
      input.rows.some((row) => row.controlUpdatedAt.getTime() !== controlUpdatedAt.getTime()) ||
      controlUpdatedAt > input.loadedAt ||
      input.loadedAt.getTime() - controlUpdatedAt.getTime() > this.#maxAgeMs
    ) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics internal-exclusion control" });
    }
  }
}

import { InternalServerError } from "../lib/errors.js";
import {
  ProductAnalyticsDeletionTargetStatus,
  type ProductAnalyticsDeletionTarget,
} from "../models/product-analytics-export.js";
import { productAnalyticsDeletionRequestIdSchema } from "../types/product-analytics.js";

const userKeyPattern = /^[a-f0-9]{64}$/;

type ProductAnalyticsDeletionTargetDataApi = {
  findByRequestId(input: { requestId: string }): Promise<ProductAnalyticsDeletionTarget | null>;
  upsert(input: { target: ProductAnalyticsDeletionTarget }): Promise<void>;
};

export class ProductAnalyticsDeletionTargetRepository {
  readonly #api: ProductAnalyticsDeletionTargetDataApi;

  constructor(deps: { api: ProductAnalyticsDeletionTargetDataApi }) {
    this.#api = deps.api;
  }

  async handoff(input: {
    requestId: string;
    userKey: string;
    suppressedAt: Date;
  }): Promise<ProductAnalyticsDeletionTarget> {
    if (
      !productAnalyticsDeletionRequestIdSchema.safeParse(input.requestId).success ||
      !userKeyPattern.test(input.userKey) ||
      Number.isNaN(input.suppressedAt.getTime())
    ) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics deletion target" });
    }

    const existing = await this.#api.findByRequestId({ requestId: input.requestId });
    if (existing) {
      if (existing.userKey !== input.userKey || existing.suppressedAt.getTime() !== input.suppressedAt.getTime()) {
        throw new InternalServerError({ debugMessage: "Product analytics deletion request ID collision" });
      }
      return existing;
    }

    const target: ProductAnalyticsDeletionTarget = {
      requestId: input.requestId,
      userKey: input.userKey,
      suppressedAt: input.suppressedAt,
      status: ProductAnalyticsDeletionTargetStatus.Pending,
    };
    await this.#api.upsert({ target });
    const committed = await this.#api.findByRequestId({ requestId: input.requestId });
    if (
      !committed ||
      committed.userKey !== input.userKey ||
      committed.suppressedAt.getTime() !== input.suppressedAt.getTime()
    ) {
      throw new InternalServerError({ debugMessage: "Product analytics deletion target handoff failed" });
    }
    return committed;
  }

  async findStatus(input: { requestId: string }): Promise<ProductAnalyticsDeletionTargetStatus | null> {
    if (!productAnalyticsDeletionRequestIdSchema.safeParse(input.requestId).success) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics deletion request ID" });
    }
    return (await this.#api.findByRequestId(input))?.status ?? null;
  }
}

import { InternalServerError } from "../lib/errors.js";
import { productAnalyticsUserKeyFor } from "../lib/product-analytics-user-key.js";
import type { ProductAnalyticsDeletionTargetStatus } from "../models/product-analytics-export.js";
import type { ProductAnalyticsExportSuppression } from "../repositories/user-repo.js";

const requestIdPattern = /^[A-Za-z0-9_-]{8,128}$/;

type ProductAnalyticsSuppressionService = {
  suppressExport(input: { userId: string; suppressedAt: Date }): Promise<ProductAnalyticsExportSuppression>;
};

type ProductAnalyticsDeletionTargetHandoffRepository = {
  handoff(input: {
    requestId: string;
    userKey: string;
    suppressedAt: Date;
  }): Promise<{ requestId: string; status: ProductAnalyticsDeletionTargetStatus }>;
};

export type ProductAnalyticsDeletionHandoffResult = {
  requestId: string;
  status: ProductAnalyticsDeletionTargetStatus;
};

export class ProductAnalyticsDeletionService {
  readonly #preferenceService: ProductAnalyticsSuppressionService;
  readonly #deletionTargetRepo: ProductAnalyticsDeletionTargetHandoffRepository;
  readonly #clock: () => Date;

  constructor(deps: {
    preferenceService: ProductAnalyticsSuppressionService;
    deletionTargetRepo: ProductAnalyticsDeletionTargetHandoffRepository;
    clock?: () => Date;
  }) {
    this.#preferenceService = deps.preferenceService;
    this.#deletionTargetRepo = deps.deletionTargetRepo;
    this.#clock = deps.clock ?? (() => new Date());
  }

  async suppressAndHandoff(input: {
    userId: string;
    requestId: string;
  }): Promise<ProductAnalyticsDeletionHandoffResult> {
    if (!requestIdPattern.test(input.requestId)) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics deletion handoff input" });
    }
    const requestedAt = this.#clock();
    if (Number.isNaN(requestedAt.getTime())) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics deletion handoff time" });
    }

    const suppression = await this.#preferenceService.suppressExport({
      userId: input.userId,
      suppressedAt: requestedAt,
    });
    const userKey = productAnalyticsUserKeyFor({ userId: input.userId });
    const target = await this.#deletionTargetRepo.handoff({
      requestId: input.requestId,
      userKey,
      suppressedAt: suppression.suppressedAt,
    });
    return { requestId: target.requestId, status: target.status };
  }
}

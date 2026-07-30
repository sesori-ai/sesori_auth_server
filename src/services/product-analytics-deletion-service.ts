import { InternalServerError } from "../lib/errors.js";
import type { ProductAnalyticsDeletionTargetStatus } from "../models/product-analytics-export.js";
import type { ProductAnalyticsExportSuppressionWithKeys } from "./product-analytics-preference-service.js";
import { productAnalyticsDeletionRequestIdSchema } from "../types/product-analytics.js";

type ProductAnalyticsSuppressionService = {
  suppressExport(input: { userId: string; suppressedAt: Date }): Promise<ProductAnalyticsExportSuppressionWithKeys>;
};

type ProductAnalyticsDeletionTargetHandoffRepository = {
  handoff(input: {
    requestId: string;
    userKey: string;
    legacyFirebaseUserId: string;
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
    if (!productAnalyticsDeletionRequestIdSchema.safeParse(input.requestId).success) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics deletion handoff input" });
    }
    const requestedAt = this.#clock();
    if (Number.isNaN(requestedAt.getTime())) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics deletion handoff time" });
    }

    // This order is load-bearing: commit the permanent source tombstone first,
    // then use its derived key for the idempotent restricted handoff. A handoff
    // failure leaves suppression observable and safe to retry with requestId.
    const suppression = await this.#preferenceService.suppressExport({
      userId: input.userId,
      suppressedAt: requestedAt,
    });
    const target = await this.#deletionTargetRepo.handoff({
      requestId: input.requestId,
      userKey: suppression.userKey,
      legacyFirebaseUserId: suppression.legacyFirebaseUserId,
      suppressedAt: suppression.suppressedAt,
    });
    return { requestId: target.requestId, status: target.status };
  }
}

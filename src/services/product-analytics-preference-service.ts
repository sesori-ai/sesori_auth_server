import { NotFoundError } from "../lib/errors.js";
import {
  copyProductAnalyticsPseudonymizationKey,
  legacyFirebaseAnalyticsUserIdFor,
  productAnalyticsUserKeyFor,
} from "../lib/product-analytics-user-key.js";
import type { UserRepository } from "../repositories/user-repo.js";
import type { ProductAnalyticsExportSuppression } from "../repositories/user-repo.js";
import type {
  ProductAnalyticsPreference,
  ProductAnalyticsPreferenceRecord,
  ProductAnalyticsPreferenceUpdateResult,
} from "../types/product-analytics.js";

export type ProductAnalyticsPreferenceRecordWithUserKey = ProductAnalyticsPreferenceRecord & {
  userKey: string;
};

export type ProductAnalyticsPreferenceUpdateResultWithUserKey = ProductAnalyticsPreferenceUpdateResult & {
  userKey: string;
};

export type ProductAnalyticsExportSuppressionWithKeys = ProductAnalyticsExportSuppression & {
  userKey: string;
  legacyFirebaseUserId: string;
};

export class ProductAnalyticsPreferenceService {
  readonly #userRepo: UserRepository;
  readonly #pseudonymizationKey: Buffer;

  constructor(deps: { userRepo: UserRepository; pseudonymizationKey: Uint8Array }) {
    this.#userRepo = deps.userRepo;
    this.#pseudonymizationKey = copyProductAnalyticsPseudonymizationKey({ value: deps.pseudonymizationKey });
  }

  async getPreference(input: { userId: string }): Promise<ProductAnalyticsPreferenceRecordWithUserKey> {
    const preference = await this.#userRepo.findProductAnalyticsPreference({ userId: input.userId });
    if (!preference) {
      throw new NotFoundError({ debugMessage: "Product analytics preference user not found" });
    }
    return { ...preference, userKey: this.#userKeyFor({ userId: input.userId }) };
  }

  async updatePreference(input: {
    userId: string;
    preference: ProductAnalyticsPreference;
    expectedRevision: number;
    operationId: string;
  }): Promise<ProductAnalyticsPreferenceUpdateResultWithUserKey> {
    const result = await this.#userRepo.updateProductAnalyticsPreference(input);
    if (!result) {
      throw new NotFoundError({ debugMessage: "Product analytics preference user not found" });
    }
    return { ...result, userKey: this.#userKeyFor({ userId: input.userId }) };
  }

  async suppressExport(input: {
    userId: string;
    suppressedAt: Date;
  }): Promise<ProductAnalyticsExportSuppressionWithKeys> {
    const suppression = await this.#userRepo.suppressProductAnalyticsExport(input);
    if (!suppression) {
      throw new NotFoundError({ debugMessage: "Product analytics preference user not found" });
    }
    return {
      ...suppression,
      userKey: this.#userKeyFor({ userId: input.userId }),
      legacyFirebaseUserId: legacyFirebaseAnalyticsUserIdFor({ userId: input.userId }),
    };
  }

  #userKeyFor(input: { userId: string }): string {
    return productAnalyticsUserKeyFor({
      userId: input.userId,
      pseudonymizationKey: this.#pseudonymizationKey,
    });
  }
}

import { NotFoundError } from "../lib/errors.js";
import type { UserRepository } from "../repositories/user-repo.js";
import type {
  ProductAnalyticsPreference,
  ProductAnalyticsPreferenceRecord,
  ProductAnalyticsPreferenceUpdateResult,
} from "../types/product-analytics.js";

export class ProductAnalyticsPreferenceService {
  readonly #userRepo: UserRepository;

  constructor(deps: { userRepo: UserRepository }) {
    this.#userRepo = deps.userRepo;
  }

  async getPreference(input: { userId: string }): Promise<ProductAnalyticsPreferenceRecord> {
    const preference = await this.#userRepo.findProductAnalyticsPreference({ userId: input.userId });
    if (!preference) {
      throw new NotFoundError({ debugMessage: "Product analytics preference user not found" });
    }
    return preference;
  }

  async updatePreference(input: {
    userId: string;
    preference: ProductAnalyticsPreference;
    expectedRevision: number;
    operationId: string;
  }): Promise<ProductAnalyticsPreferenceUpdateResult> {
    const result = await this.#userRepo.updateProductAnalyticsPreference(input);
    if (!result) {
      throw new NotFoundError({ debugMessage: "Product analytics preference user not found" });
    }
    return result;
  }
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ObjectId } from "mongodb";
import { userSchema } from "../../src/models/documents.js";
import { ProductAnalyticsPreference } from "../../src/types/product-analytics.js";

describe("product analytics user schema", () => {
  const baseUser = {
    _id: new ObjectId(),
    tokenVersion: 0,
    createdAt: new Date("2026-07-28T12:00:00.000Z"),
    updatedAt: new Date("2026-07-28T12:00:00.000Z"),
  };

  it("requires every write-first preference field", () => {
    assert.equal(userSchema.safeParse(baseUser).success, false);
    assert.equal(
      userSchema.safeParse({
        ...baseUser,
        productAnalyticsPreference: ProductAnalyticsPreference.Enabled,
        productAnalyticsPreferenceUpdatedAt: baseUser.createdAt,
        productAnalyticsPreferenceRevision: 1,
        productAnalyticsPreferenceLastOperationId: null,
      }).success,
      true,
    );
  });
});

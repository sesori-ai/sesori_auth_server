import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadProductAnalyticsDeletionConfig } from "../../src/scripts/product-analytics-deletion-config.js";
import { loadProductAnalyticsExportConfig } from "../../src/scripts/product-analytics-export-config.js";
import { parseProductAnalyticsSuppressionInput } from "../../src/scripts/suppress-product-analytics-export.js";

describe("product analytics command configuration", () => {
  const common = {
    MONGODB_URI: "mongodb://localhost:27017",
    PRODUCT_ANALYTICS_GCP_PROJECT_ID: "valid-project",
    PRODUCT_ANALYTICS_BIGQUERY_LOCATION: "europe-west1",
    PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY: Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64"),
  };

  it("loads bounded export-only configuration without service-account keys", () => {
    const config = loadProductAnalyticsExportConfig({
      env: {
        ...common,
        PRODUCT_ANALYTICS_AUTH_DATASET_ID: "auth_private",
        PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_VIEW: "valid-project.controls.active_internal_users",
      },
    });

    assert.equal(config.PRODUCT_ANALYTICS_EXPORT_BATCH_LIMIT, 500);
    assert.equal(config.PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_MAX_KEYS, 10_000);
    assert.equal(
      Object.keys(config).some((key) => key.includes("SERVICE_ACCOUNT")),
      false,
    );
    assert.throws(
      () =>
        loadProductAnalyticsExportConfig({
          env: {
            ...common,
            PRODUCT_ANALYTICS_AUTH_DATASET_ID: "auth_private",
            PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_VIEW: "valid-project.controls.active_internal_users",
            PRODUCT_ANALYTICS_EXPORT_BATCH_LIMIT: "1001",
          },
        }),
      /Invalid product analytics export configuration/,
    );
  });

  it("normalizes locations and rejects invalid GCP project IDs with field details", () => {
    const config = loadProductAnalyticsExportConfig({
      env: {
        ...common,
        PRODUCT_ANALYTICS_BIGQUERY_LOCATION: "  europe-west1  ",
        PRODUCT_ANALYTICS_AUTH_DATASET_ID: "auth_private",
        PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_VIEW: "valid-project.controls.active_internal_users",
      },
    });

    assert.equal(config.PRODUCT_ANALYTICS_BIGQUERY_LOCATION, "europe-west1");
    assert.throws(
      () =>
        loadProductAnalyticsExportConfig({
          env: {
            ...common,
            PRODUCT_ANALYTICS_GCP_PROJECT_ID: "a".repeat(31),
            PRODUCT_ANALYTICS_AUTH_DATASET_ID: "auth_private",
            PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_VIEW: "valid-project.controls.active_internal_users",
          },
        }),
      /PRODUCT_ANALYTICS_GCP_PROJECT_ID/,
    );
    assert.throws(
      () =>
        loadProductAnalyticsDeletionConfig({
          env: {
            ...common,
            PRODUCT_ANALYTICS_PRIVACY_DATASET_ID: "invalid-dataset",
          },
        }),
      /PRODUCT_ANALYTICS_PRIVACY_DATASET_ID/,
    );
    assert.throws(
      () =>
        loadProductAnalyticsDeletionConfig({
          env: {
            ...common,
            PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY: Buffer.alloc(31).toString("base64"),
            PRODUCT_ANALYTICS_PRIVACY_DATASET_ID: "privacy_private",
          },
        }),
      /PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY/,
    );
  });

  it("keeps privacy-target configuration separate from auth-export access", () => {
    const config = loadProductAnalyticsDeletionConfig({
      env: {
        ...common,
        PRODUCT_ANALYTICS_PRIVACY_DATASET_ID: "privacy_private",
      },
    });

    assert.equal(config.PRODUCT_ANALYTICS_PRIVACY_DATASET_ID, "privacy_private");
    assert.equal(Object.hasOwn(config, "PRODUCT_ANALYTICS_AUTH_DATASET_ID"), false);
    assert.equal(Object.hasOwn(config, "PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_VIEW"), false);
  });

  it("accepts protected JSON input and rejects malformed or unbounded values", () => {
    assert.deepEqual(
      parseProductAnalyticsSuppressionInput({
        value: JSON.stringify({
          userId: "000000000000000000000001",
          requestId: "privacy_request_001",
        }),
      }),
      { userId: "000000000000000000000001", requestId: "privacy_request_001" },
    );
    assert.throws(
      () => parseProductAnalyticsSuppressionInput({ value: JSON.stringify({ userId: "invalid", requestId: "short" }) }),
      /Invalid product analytics suppression input/,
    );
    assert.throws(
      () => parseProductAnalyticsSuppressionInput({ value: " ".repeat(4_097) }),
      /Product analytics suppression input is too large/,
    );
    assert.throws(() => parseProductAnalyticsSuppressionInput({ value: "" }), SyntaxError);
    for (const value of [null, [], 42]) {
      assert.throws(
        () => parseProductAnalyticsSuppressionInput({ value: JSON.stringify(value) }),
        /Invalid product analytics suppression input/,
      );
    }
  });
});

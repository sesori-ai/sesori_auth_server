import { z } from "zod";
import { productAnalyticsConfigurationError } from "./product-analytics-cli-utils.js";

const productAnalyticsDeletionConfigSchema = z.object({
  MONGODB_URI: z.string().min(1),
  PRODUCT_ANALYTICS_GCP_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  PRODUCT_ANALYTICS_PRIVACY_DATASET_ID: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/),
  PRODUCT_ANALYTICS_BIGQUERY_LOCATION: z.string().trim().min(1),
});

export type ProductAnalyticsDeletionConfig = z.infer<typeof productAnalyticsDeletionConfigSchema>;

export function loadProductAnalyticsDeletionConfig(input: { env?: NodeJS.ProcessEnv }): ProductAnalyticsDeletionConfig {
  const result = productAnalyticsDeletionConfigSchema.safeParse(input.env ?? process.env);
  if (!result.success) {
    throw productAnalyticsConfigurationError({ description: "product analytics deletion", error: result.error });
  }
  return result.data;
}

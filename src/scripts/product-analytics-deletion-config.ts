import { z } from "zod";

const productAnalyticsDeletionConfigSchema = z.object({
  MONGODB_URI: z.string().min(1),
  PRODUCT_ANALYTICS_GCP_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
  PRODUCT_ANALYTICS_PRIVACY_DATASET_ID: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/),
  PRODUCT_ANALYTICS_BIGQUERY_LOCATION: z.string().min(1),
});

export type ProductAnalyticsDeletionConfig = z.infer<typeof productAnalyticsDeletionConfigSchema>;

export function loadProductAnalyticsDeletionConfig(input: { env?: NodeJS.ProcessEnv }): ProductAnalyticsDeletionConfig {
  const result = productAnalyticsDeletionConfigSchema.safeParse(input.env ?? process.env);
  if (!result.success) {
    throw new Error("Invalid product analytics deletion configuration");
  }
  return result.data;
}

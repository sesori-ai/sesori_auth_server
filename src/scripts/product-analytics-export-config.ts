import { z } from "zod";

const positiveIntegerFromEnvironment = (defaultValue: number, maximum: number) =>
  z.preprocess(
    (value) => (value === undefined ? defaultValue : Number(value)),
    z.number().int().positive().max(maximum),
  );

const productAnalyticsExportConfigSchema = z.object({
  MONGODB_URI: z.string().min(1),
  PRODUCT_ANALYTICS_GCP_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
  PRODUCT_ANALYTICS_AUTH_DATASET_ID: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/),
  PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_VIEW: z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/),
  PRODUCT_ANALYTICS_BIGQUERY_LOCATION: z.string().min(1),
  PRODUCT_ANALYTICS_EXPORT_BATCH_LIMIT: positiveIntegerFromEnvironment(500, 1_000),
  PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_MAX_KEYS: positiveIntegerFromEnvironment(10_000, 100_000),
  PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_MAX_AGE_MS: positiveIntegerFromEnvironment(
    2 * 24 * 60 * 60 * 1_000,
    30 * 24 * 60 * 60 * 1_000,
  ),
});

export type ProductAnalyticsExportConfig = z.infer<typeof productAnalyticsExportConfigSchema>;

export function loadProductAnalyticsExportConfig(input: { env?: NodeJS.ProcessEnv }): ProductAnalyticsExportConfig {
  const result = productAnalyticsExportConfigSchema.safeParse(input.env ?? process.env);
  if (!result.success) {
    throw new Error("Invalid product analytics export configuration");
  }
  return result.data;
}

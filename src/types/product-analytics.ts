import { z } from "zod";

export enum ProductAnalyticsPreference {
  Enabled = "enabled",
  Disabled = "disabled",
}

export const productAnalyticsPreferenceSchema = z.enum(ProductAnalyticsPreference);

export const productAnalyticsPreferenceRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const productAnalyticsExpectedRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);

export const productAnalyticsOperationIdSchema = z.string().uuid();

export const productAnalyticsDeletionRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

export const productAnalyticsUserKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isValidProductAnalyticsPseudonymizationKey(input: { value: string }): boolean {
  if (!canonicalBase64Pattern.test(input.value)) {
    return false;
  }
  const decoded = Buffer.from(input.value, "base64");
  return decoded.byteLength >= 32 && decoded.toString("base64") === input.value;
}

export const productAnalyticsPseudonymizationKeySchema = z
  .string()
  .max(512)
  .refine(
    (value) => isValidProductAnalyticsPseudonymizationKey({ value }),
    "PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY must be canonical base64 for at least 32 random bytes",
  )
  .transform((value) => Buffer.from(value, "base64"));

export type ProductAnalyticsPseudonymizationKey = z.infer<typeof productAnalyticsPseudonymizationKeySchema>;

export type ProductAnalyticsPreferenceRecord = {
  preference: ProductAnalyticsPreference;
  updatedAt: Date;
  revision: number;
};

export enum ProductAnalyticsPreferenceUpdateOutcome {
  Updated = "updated",
  Conflict = "conflict",
}

export type ProductAnalyticsPreferenceUpdateResult =
  | {
      outcome: ProductAnalyticsPreferenceUpdateOutcome.Updated;
      record: ProductAnalyticsPreferenceRecord;
    }
  | {
      outcome: ProductAnalyticsPreferenceUpdateOutcome.Conflict;
      record: ProductAnalyticsPreferenceRecord;
    };

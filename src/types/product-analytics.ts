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

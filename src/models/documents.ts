import { ObjectId } from "mongodb";
import { z } from "zod";
import { bridgeIdSchema, bridgePlatformSchema, bridgeStatusSchema } from "./bridge.js";
import { devicePlatformSchema } from "./device.js";
import {
  productAnalyticsOperationIdSchema,
  productAnalyticsPreferenceRevisionSchema,
  productAnalyticsPreferenceSchema,
} from "../types/product-analytics.js";

export const userSchema = z.object({
  _id: z.instanceof(ObjectId),
  tokenVersion: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
  productAnalyticsPreference: productAnalyticsPreferenceSchema,
  productAnalyticsPreferenceUpdatedAt: z.date(),
  productAnalyticsPreferenceRevision: productAnalyticsPreferenceRevisionSchema,
  productAnalyticsPreferenceLastOperationId: productAnalyticsOperationIdSchema.nullable(),
  // Absence is meaningful: only the privacy-deletion flow creates this
  // permanent export-suppression tombstone, so it has no migration default.
  productAnalyticsExportSuppressedAt: z.date().nullable().optional(),
});

export type User = z.infer<typeof userSchema>;

export const oauthAccountSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  provider: z.string(),
  providerUserId: z.string(),
  providerUsername: z.string().nullable(),
  email: z.string().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OAuthAccount = z.infer<typeof oauthAccountSchema>;

export const passwordAccountSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  email: z.string().trim().toLowerCase(),
  passwordHash: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PasswordAccount = z.infer<typeof passwordAccountSchema>;

export const passwordAccountInputSchema = passwordAccountSchema.omit({
  _id: true,
  createdAt: true,
  updatedAt: true,
});

export type PasswordAccountInput = z.infer<typeof passwordAccountInputSchema>;

export const glossaryEntrySchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  word: z.string(),
  createdAt: z.date(),
});

export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

export const dailyUsageSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  date: z.string(),
  transcriptionSeconds: z.number(),
  metadataRequestCount: z.number().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DailyUsage = z.infer<typeof dailyUsageSchema>;

export const deviceTokenSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  token: z.string(),
  platform: devicePlatformSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DeviceToken = z.infer<typeof deviceTokenSchema>;

export const bridgeSchema = z.object({
  _id: z.instanceof(ObjectId),
  bridgeId: bridgeIdSchema,
  userId: z.instanceof(ObjectId),
  name: z.string().min(1).max(120),
  platform: bridgePlatformSchema,
  status: bridgeStatusSchema,
  addedAt: z.date(),
  lastSeenAt: z.date().nullable(),
  lastSeenIp: z.string().nullable().optional(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Bridge = z.infer<typeof bridgeSchema>;

/**
 * One activation-funnel document per user. Do not conflate these categories:
 * milestones are real event times; reminder baselines are campaign start times
 * that may diverge after backfill; sent markers independently suppress each
 * reminder; backfilledAt records enrollment by the backfill script.
 * See .plans/activation-reminders/CONSIDERATIONS.md, "Timestamp Semantics".
 */
export const activationStateSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  mobileSetupAt: z.date().nullable(),
  bridgeSetupAt: z.date().nullable(),
  firstSessionAt: z.date().nullable(),
  bridgeReminderBaseAt: z.date().nullable(),
  sessionReminderBaseAt: z.date().nullable(),
  bridgeReminder1SentAt: z.date().nullable(),
  bridgeReminder2SentAt: z.date().nullable(),
  sessionReminderSentAt: z.date().nullable(),
  backfilledAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ActivationState = z.infer<typeof activationStateSchema>;

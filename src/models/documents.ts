import { ObjectId } from "mongodb";
import { z } from "zod";
import { bridgeIdSchema, bridgePlatformSchema, bridgeStatusSchema } from "./bridge.js";
import { devicePlatformSchema } from "./device.js";
import { deviceIdSchema, storedNotificationSettingsSchema } from "./settings.js";
import {
  productAnalyticsOperationIdSchema,
  productAnalyticsPreferenceRevisionSchema,
  productAnalyticsPreferenceSchema,
} from "../types/product-analytics.js";
import { projectKeySchema } from "./voice.js";

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

export const glossaryEntrySchema = z
  .object({
    _id: z.instanceof(ObjectId),
    userId: z.instanceof(ObjectId),
    projectKey: projectKeySchema,
    bridgeId: bridgeIdSchema.optional(),
    word: z.string(),
    createdAt: z.date(),
  })
  .strict();

export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

// COMPATIBILITY 2026-08-02 (v0.1.0): Supports auditing pre-PR2 unscoped glossary documents during project-scope cutover and rollback. After PR2 is verified in production, its rollback window closes, and no pre-PR2 binary can be deployed, remove this schema; the legacy document audit, index constants/classification, apply-drop, and rollback paths in glossary-index-migration.ts; the CLI rollback mode/runbook if no longer operationally needed; and their model/migration tests.
export const legacyGlossaryEntryMigrationSchema = glossaryEntrySchema.omit({ projectKey: true });
export const projectScopedGlossaryEntryMigrationSchema = glossaryEntrySchema;

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
  // Joins a push token to its settingsConfiguration document. Null for tokens
  // registered before clients started sending it; those deliver unfiltered.
  deviceId: deviceIdSchema.nullable().optional(),
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

// One document per (userId, deviceId). `notifications` is stored sparse — only
// the toggles the device has explicitly set — and defaults are applied on read
// (see resolveNotificationSettings), so records survive registry changes.
export const settingsConfigurationSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  deviceId: deviceIdSchema,
  notifications: storedNotificationSettingsSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SettingsConfiguration = z.infer<typeof settingsConfigurationSchema>;

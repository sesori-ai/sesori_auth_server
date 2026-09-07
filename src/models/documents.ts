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
import { normalizedGlossaryWordSchema, projectGlossaryScopeSchema } from "./voice.js";
import {
  OptionalEmailReminderKind,
  OptionalEmailSendBlockReason,
  OptionalEmailSendDeferralReason,
  OptionalEmailSendStatus,
  OptionalEmailSuppressionReason,
} from "../types/optional-email.js";

const utcCalendarDateSchema = z.string().refine(
  (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  },
  { message: "must be a valid UTC calendar date" },
);

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
    scope: projectGlossaryScopeSchema,
    words: z.array(normalizedGlossaryWordSchema),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

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

/**
 * Optional setup/reactivation mail only. This state must never gate password,
 * security, deletion, or other essential account messages.
 */
export const optionalEmailPreferenceSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  unsubscribedAt: z.date().optional(),
  suppressedAt: z.date().optional(),
  suppressionReason: z.nativeEnum(OptionalEmailSuppressionReason).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OptionalEmailPreference = z.infer<typeof optionalEmailPreferenceSchema>;

export const optionalEmailWebhookEventSchema = z.object({
  _id: z.instanceof(ObjectId),
  eventId: z.string().min(1).max(256),
  eventType: z.string().min(1).max(128),
  processedAt: z.date(),
});

export type OptionalEmailWebhookEvent = z.infer<typeof optionalEmailWebhookEventSchema>;

export const optionalEmailSendSchema = z.object({
  _id: z.instanceof(ObjectId),
  sendKey: z.string().min(1).max(256),
  userId: z.instanceof(ObjectId),
  campaignId: z.string().min(1).max(64),
  reminderKind: z.nativeEnum(OptionalEmailReminderKind),
  status: z.nativeEnum(OptionalEmailSendStatus),
  activeLeaseId: z.instanceof(ObjectId).optional(),
  attemptCount: z.number().int().nonnegative(),
  firstProviderAttemptAt: z.date().optional(),
  lastProviderAttemptAt: z.date().optional(),
  providerEmailId: z.string().min(1).max(256).optional(),
  acceptedAt: z.date().optional(),
  lastFailureCode: z.string().min(1).max(64).optional(),
  lastBlockReason: z.nativeEnum(OptionalEmailSendBlockReason).optional(),
  lastDeferralReason: z.nativeEnum(OptionalEmailSendDeferralReason).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OptionalEmailSend = z.infer<typeof optionalEmailSendSchema>;

export const optionalEmailDailyQuotaSchema = z.object({
  _id: utcCalendarDateSchema,
  used: z.number().int().nonnegative(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OptionalEmailDailyQuota = z.infer<typeof optionalEmailDailyQuotaSchema>;

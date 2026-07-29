import type { ProductAnalyticsPreference } from "../types/product-analytics.js";

export type ProductAnalyticsExportUser = {
  userId: string;
  accountCreatedAt: Date;
  preference: ProductAnalyticsPreference;
  preferenceUpdatedAt: Date;
  exportSuppressedAt: Date | null;
};

export type ProductAnalyticsPreferenceChange = {
  userId: string;
  changedAt: Date;
  exportSuppressedAt: Date | null;
};

export type ProductAnalyticsActivationMilestones = {
  notificationRegisteredAt: Date | null;
  bridgeRegisteredAt: Date | null;
  legacyFirstMetadataRequestAt: Date | null;
};

export type ProductAnalyticsExportRow = {
  userKey: string;
  accountCreatedAt: Date;
  notificationRegisteredAt: Date | null;
  bridgeRegisteredAt: Date | null;
  legacyFirstMetadataRequestAt: Date | null;
  exportedAt: Date;
};

export type ProductAnalyticsSetupCohortRow = {
  cohortWeek: string;
  totalAccounts: number;
  enabledAccounts: number;
  notificationRegisteredWithin1Day: number;
  notificationRegisteredWithin7Days: number;
  notificationRegisteredWithin30Days: number;
  bridgeRegisteredWithin1Day: number;
  bridgeRegisteredWithin7Days: number;
  bridgeRegisteredWithin30Days: number;
  legacyFirstMetadataRequestWithin1Day: number;
  legacyFirstMetadataRequestWithin7Days: number;
  legacyFirstMetadataRequestWithin30Days: number;
  exportedAt: Date;
};

export type ProductAnalyticsExportRunMetadata = {
  runId: string;
  runCutoff: Date;
  preferenceScanCutoff: Date;
  controlUpdatedAt: Date;
  usersScanned: number;
  sourceSuppressedUsers: number;
  internalUsers: number;
  externalAccounts: number;
  enabledAccounts: number;
  optedOutAccounts: number;
  preferenceAfterCutoffAccounts: number;
  latePreferenceRowsRemoved: number;
  milestoneRowsPublished: number;
  cohortRowsPublished: number;
};

export enum ProductAnalyticsDeletionTargetStatus {
  Pending = "pending",
  Processing = "processing",
  Completed = "completed",
  Retryable = "retryable",
}

export type ProductAnalyticsDeletionTarget = {
  requestId: string;
  userKey: string;
  suppressedAt: Date;
  status: ProductAnalyticsDeletionTargetStatus;
};

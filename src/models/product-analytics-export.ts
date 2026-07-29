import type { ProductAnalyticsPreference } from "../types/product-analytics.js";

export type ProductAnalyticsExportTableField = {
  name: string;
  type: string;
  mode?: string;
};

export type ProductAnalyticsInternalExclusionRow = {
  userKey: string | null;
  controlUpdatedAt: Date;
};

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
  /** Written by auth suppression while awaiting downstream privacy processing. */
  Pending = "pending",
  /** Set by the downstream privacy processor after it claims the request. */
  Processing = "processing",
  /** Set downstream after warehouse and upstream deletion checks complete. */
  Completed = "completed",
  /** Set downstream for retry; rerunning suppression with the same request ID is idempotent and does not reset it. */
  Retryable = "retryable",
}

export type ProductAnalyticsDeletionTarget = {
  requestId: string;
  userKey: string;
  legacyFirebaseUserId: string;
  suppressedAt: Date;
  status: ProductAnalyticsDeletionTargetStatus;
};

export enum OptionalEmailRecipientBasis {
  Unapproved = "unapproved",
  AccountActivityApproved = "account_activity_approved",
}

export enum OptionalEmailSuppressionReason {
  HardBounce = "hard_bounce",
  Complaint = "complaint",
  ProviderSuppressed = "provider_suppressed",
}

export enum OptionalEmailCategory {
  SetupReminder = "optional_setup_reminder",
}

export enum OptionalEmailWebhookEventType {
  Bounced = "email.bounced",
  Complained = "email.complained",
  Suppressed = "email.suppressed",
}

export enum OptionalEmailWebhookStatus {
  Processed = "processed",
  Replayed = "replayed",
  Retry = "retry",
}

export enum OptionalEmailWebhookOutcome {
  Suppressed = "suppressed",
  Ignored = "ignored",
}

export enum OptionalEmailBlockReason {
  Unsubscribed = "unsubscribed",
  Suppressed = "suppressed",
}

export enum OptionalEmailSendBlockReason {
  SendingDisabled = "sending_disabled",
  RecipientBasisUnapproved = "recipient_basis_unapproved",
  MissingUser = "missing_user",
  MissingRecipient = "missing_recipient",
  AmbiguousRecipient = "ambiguous_recipient",
  MilestoneCompleted = "milestone_completed",
  PrerequisiteIncomplete = "prerequisite_incomplete",
  Unsubscribed = "unsubscribed",
  Suppressed = "suppressed",
  TestSendingDisabled = "test_sending_disabled",
  TestRecipientNotAllowed = "test_recipient_not_allowed",
  RetryWindowExpired = "retry_window_expired",
}

export enum OptionalEmailSendDeferralReason {
  DailyLimit = "daily_limit",
}

export enum OptionalEmailReminderKind {
  BridgeSetup = "bridge_setup",
  FirstSession = "first_session",
}

export enum OptionalEmailSendStatus {
  Reserved = "reserved",
  InFlight = "in_flight",
  Accepted = "accepted",
  Failed = "failed",
  Blocked = "blocked",
  DeferredDailyLimit = "deferred_daily_limit",
}

export enum OptionalEmailSendReservationOutcome {
  Reserved = "reserved",
  Duplicate = "duplicate",
  RetryExpired = "retry_expired",
}

// Reserved and in-flight rows carry a lease owner. Once this interval expires,
// one contender may rotate that owner with compare-and-set; transition methods
// fence stale workers by requiring the current lease ID.
export const OPTIONAL_EMAIL_RESERVATION_LEASE_MS = 5 * 60 * 1_000;

// Leave an hour of headroom inside Resend's 24-hour idempotency-key window.
export const OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS = 23 * 60 * 60 * 1_000;

// Resend's free transactional plan permits 100 emails/day. Optional mail is
// capped lower so account/security traffic and inbound quota use retain room.
export const OPTIONAL_EMAIL_MAX_DAILY_CAP = 80;

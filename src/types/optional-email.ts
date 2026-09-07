export enum OptionalEmailRecipientBasis {
  Unapproved = "unapproved",
  AccountActivityApproved = "account_activity_approved",
}

export enum OptionalEmailSuppressionReason {
  HardBounce = "hard_bounce",
  Complaint = "complaint",
  ProviderSuppressed = "provider_suppressed",
}

export enum OptionalEmailBlockReason {
  Unsubscribed = "unsubscribed",
  Suppressed = "suppressed",
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

// Resend's free transactional plan permits 100 emails/day. Optional mail is
// capped lower so account/security traffic and inbound quota use retain room.
export const OPTIONAL_EMAIL_MAX_DAILY_CAP = 80;

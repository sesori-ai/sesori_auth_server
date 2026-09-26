import { z } from "zod";
import { DevicePlatform } from "./device.js";

// Wire values shared with the app's FeedbackIssue enum; renaming one breaks
// every released client that sends it.
export enum FeedbackIssue {
  HardToNavigate = "hard_to_navigate",
  ConnectionDrops = "connection_drops",
  NotificationsMissing = "notifications_missing",
  AppSlow = "app_slow",
}

// Where the sheet was opened: the automatic prompt or the settings entry.
export enum FeedbackSource {
  Automatic = "automatic",
  Settings = "settings",
}

export const FEEDBACK_MESSAGE_MAX_LENGTH = 4000;
const FEEDBACK_APP_VERSION_MAX_LENGTH = 32;

// Only the mobile apps collect feedback today.
export const feedbackPlatformSchema = z.enum([DevicePlatform.ios, DevicePlatform.android]);
export type FeedbackPlatform = z.infer<typeof feedbackPlatformSchema>;

export const feedbackIssuesSchema = z
  .array(z.enum(FeedbackIssue))
  .refine((issues) => new Set(issues).size === issues.length, { message: "issues must be unique" });

// Both issues and message may be empty: the sheet keeps Send available with
// nothing filled in, and an empty submission is still a signal. A message is
// trimmed and must then carry text, matching how other free-text fields here
// reject whitespace-only input; the client omits an empty message.
export const submitFeedbackBodySchema = z.object({
  issues: feedbackIssuesSchema,
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX_LENGTH).optional(),
  source: z.enum(FeedbackSource),
  platform: feedbackPlatformSchema,
  appVersion: z.string().trim().min(1).max(FEEDBACK_APP_VERSION_MAX_LENGTH),
});
export type SubmitFeedbackBody = z.infer<typeof submitFeedbackBodySchema>;

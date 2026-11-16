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

/**
 * Permanent wire contract of `POST /product-analytics/events`. Installed desktop
 * apps cannot be re-pointed, so `schemaVersion: 1` stays accepted indefinitely
 * and changes are additive. This closed schema is the privacy boundary: every
 * parameter is a closed enum, so free text cannot be stored.
 */
export enum ProductAnalyticsEventName {
  AnalyticsSchemaReady = "analytics_schema_ready",
  AnalyticsActivationReady = "analytics_activation_ready",
  ProjectInventoryLoaded = "project_inventory_loaded",
  SessionActivityViewed = "session_activity_viewed",
  SessionMessageSent = "session_message_sent",
  SessionCreatedWithMessage = "session_created_with_message",
  SessionCreationFailed = "session_creation_failed",
  VoiceTranscriptionCompleted = "voice_transcription_completed",
  SessionQuestionAnswered = "session_question_answered",
  SessionQuestionRejected = "session_question_rejected",
  SessionPermissionAnswered = "session_permission_answered",
  SessionAbortSucceeded = "session_abort_succeeded",
  SessionDiffViewed = "session_diff_viewed",
  FeedbackPromptAnswered = "feedback_prompt_answered",
  PrivateFeedbackSent = "private_feedback_sent",
  OnboardingNeedHelpOpened = "onboarding_need_help_opened",
  OnboardingSupportLinkOpened = "onboarding_support_link_opened",
  OnboardingWhyBridgeOpened = "onboarding_why_bridge_opened",
  BridgeInstallCommandCopied = "bridge_install_command_copied",
  BridgeInstallCommandShared = "bridge_install_command_shared",
  BridgeRunCommandCopied = "bridge_run_command_copied",
  BridgeRunCommandShared = "bridge_run_command_shared",
  ProductScreenViewed = "product_screen_viewed",
  PromptFilesSent = "prompt_files_sent",
  HarnessInstallFinished = "harness_install_finished",
  TranscriptPromptsOpened = "transcript_prompts_opened",
  ComputerSwitched = "computer_switched",
  ComputerManaged = "computer_managed",
  SessionPinChanged = "session_pin_changed",
  SideQuestionAsked = "side_question_asked",
  SessionMessageEdited = "session_message_edited",
  SessionSentToSession = "session_sent_to_session",
}

// Uppercase to match GA4's IOS and ANDROID in the same warehouse column.
export enum ProductAnalyticsEventPlatform {
  MacOs = "MACOS",
  Linux = "LINUX",
  Windows = "WINDOWS",
}

export enum ProductAnalyticsActivationSchemaVersion {
  V1 = "1",
}

export enum ProductAnalyticsContentState {
  Empty = "empty",
  NonEmpty = "non_empty",
}

export enum ProductAnalyticsSubmissionKind {
  Text = "text",
  Command = "command",
}

export enum ProductAnalyticsInputMode {
  Typed = "typed",
  VoiceAssisted = "voice_assisted",
}

export enum ProductAnalyticsWorkspaceKind {
  Project = "project",
  DedicatedWorktree = "dedicated_worktree",
  NoProject = "no_project",
}

export enum ProductAnalyticsSessionFailureReason {
  NotAuthenticated = "not_authenticated",
  ServerRejected = "server_rejected",
  NetworkDown = "network_down",
  BadResponse = "bad_response",
  Unknown = "unknown",
}

export enum ProductAnalyticsPermissionDecision {
  Once = "once",
  Always = "always",
  Reject = "reject",
}

export enum ProductAnalyticsFeedbackAnswer {
  LoveReviewRequested = "love_review_requested",
  LoveNoReview = "love_no_review",
  CouldBeBetter = "could_be_better",
  Dismissed = "dismissed",
}

export enum ProductAnalyticsFeedbackInput {
  Typed = "typed",
  VoiceAssisted = "voice_assisted",
  IssuesOnly = "issues_only",
  Empty = "empty",
}

export enum ProductAnalyticsFeedbackSource {
  Automatic = "automatic",
  Settings = "settings",
}

export enum ProductAnalyticsOnboardingSurface {
  ConnectSetup = "connect_setup",
  ConnectedEmpty = "connected_empty",
  BridgeOffline = "bridge_offline",
}

export enum ProductAnalyticsSupportChannel {
  Email = "email",
  Discord = "discord",
  X = "x",
}

export enum ProductAnalyticsInstallMethod {
  Curl = "curl",
  Powershell = "powershell",
  Npm = "npm",
  Bun = "bun",
}

// The bridge install command's target. The app's own OS is `platform`.
export enum ProductAnalyticsInstallOs {
  Unix = "unix",
  Windows = "windows",
}

export enum ProductAnalyticsScreen {
  Login = "login",
  Projects = "projects",
  Settings = "settings",
  SettingsDefaultInput = "settings_default_input",
  SettingsNotifications = "settings_notifications",
  SettingsProfile = "settings_profile",
  Sessions = "sessions",
  NewSession = "new_session",
  SessionDetail = "session_detail",
  SessionDiffs = "session_diffs",
  ScheduledTasks = "scheduled_tasks",
  ScheduledTaskDetail = "scheduled_task_detail",
}

// How many saved files an accepted prompt carried, bucketed.
export enum ProductAnalyticsFileCountBucket {
  One = "1",
  TwoToFour = "2_4",
  FivePlus = "5_plus",
}

// How the prompt's files were added; `mixed` means more than one way.
export enum ProductAnalyticsFileSource {
  Picker = "picker",
  Drop = "drop",
  Paste = "paste",
  Mixed = "mixed",
}

// Which shipped coding harness ran a message or side question; `other` covers
// any harness Sesori does not ship. Optional on the message events because
// released desktop versions omit it there.
export enum ProductAnalyticsHarness {
  Opencode = "opencode",
  Codex = "codex",
  GithubCopilot = "github_copilot",
  Cursor = "cursor",
  ClaudeCode = "claude_code",
  HermesAgent = "hermes_agent",
  Pi = "pi",
  OhMyPi = "oh_my_pi",
  Deepseek = "deepseek",
  GrokBuild = "grok_build",
  Antigravity = "antigravity",
  Other = "other",
}

// A boolean param, which the client sends as its string form.
export enum ProductAnalyticsBoolean {
  True = "true",
  False = "false",
}

// A client-triggered managed harness runtime install. The harness and any
// failure text stay off the wire.
export enum ProductAnalyticsHarnessInstallOutcome {
  Completed = "completed",
  Failed = "failed",
}

// What opened the Prompts screen.
export enum ProductAnalyticsPromptsEntry {
  SessionBar = "session_bar",
  Pinch = "pinch",
}

// Where a switch to another computer started.
export enum ProductAnalyticsComputerSwitchSource {
  Menu = "menu",
  OfflineScreen = "offline_screen",
  Settings = "settings",
  Alert = "alert",
  Notification = "notification",
  ComputersPage = "computers_page",
  CommandPalette = "command_palette",
}

// What the user did to a computer from the Computers page.
export enum ProductAnalyticsComputerManageAction {
  Renamed = "renamed",
  Removed = "removed",
}

// How one side question ended.
export enum ProductAnalyticsSideQuestionOutcome {
  Answered = "answered",
  NoAnswer = "no_answer",
  Unavailable = "unavailable",
  Failed = "failed",
}

// How the bridge answered one edit and resend of an earlier message. `failed`
// means the request failed or timed out, so the edit may or may not have run.
export enum ProductAnalyticsMessageEditOutcome {
  Succeeded = "succeeded",
  RefusedBusy = "refused_busy",
  BranchPointUnavailable = "branch_point_unavailable",
  Refused = "refused",
  Failed = "failed",
}

// How one send of a session into another ended. `unsupported` is a bridge that
// predates sending; `unconfirmed` means the answer never arrived, so the send
// may or may not have finished.
export enum ProductAnalyticsSessionSendOutcome {
  Sent = "sent",
  RefusedBusy = "refused_busy",
  RefusedOther = "refused_other",
  Failed = "failed",
  Unsupported = "unsupported",
  Unconfirmed = "unconfirmed",
}

// What became of a dictation's words. Optional, with ProductAnalyticsVoiceMode,
// because released desktop versions send no voice params.
export enum ProductAnalyticsVoiceFinish {
  Sent = "sent",
  Edited = "edited",
  CutOff = "cut_off",
}

// How a dictation actually ran; a fallback reports `after_recording`.
export enum ProductAnalyticsVoiceMode {
  Live = "live",
  AfterRecording = "after_recording",
  OnDevice = "on_device",
}

function eventBodySchema<TName extends ProductAnalyticsEventName, TParams extends z.ZodType>(input: {
  name: TName;
  params: TParams;
}) {
  return z.strictObject({
    schemaVersion: z.literal(1),
    platform: z.enum(ProductAnalyticsEventPlatform),
    appVersion: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/),
    name: z.literal(input.name),
    occurredAtMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    params: input.params,
  });
}

const noEventParamsSchema = z.strictObject({});

const contentStateSchema = z.enum(ProductAnalyticsContentState);
const workspaceKindSchema = z.enum(ProductAnalyticsWorkspaceKind);
const feedbackSourceSchema = z.enum(ProductAnalyticsFeedbackSource);
const onboardingSurfaceSchema = z.enum(ProductAnalyticsOnboardingSurface);

const messageSubmissionShape = {
  submission_kind: z.enum(ProductAnalyticsSubmissionKind),
  input_mode: z.enum(ProductAnalyticsInputMode),
  harness: z.enum(ProductAnalyticsHarness).optional(),
};

function commandIsTyped(input: {
  submission_kind: ProductAnalyticsSubmissionKind;
  input_mode: ProductAnalyticsInputMode;
}): boolean {
  return (
    input.submission_kind !== ProductAnalyticsSubmissionKind.Command ||
    input.input_mode === ProductAnalyticsInputMode.Typed
  );
}

const installCommandParamsSchema = z.strictObject({
  surface: onboardingSurfaceSchema,
  method: z.enum(ProductAnalyticsInstallMethod),
  os: z.enum(ProductAnalyticsInstallOs),
});

const surfaceParamsSchema = z.strictObject({ surface: onboardingSurfaceSchema });

/**
 * Validates everything except the time bound, which needs the request's single
 * clock read and so lives in `ProductAnalyticsEventService`.
 */
export const productAnalyticsEventBodySchema = z.discriminatedUnion("name", [
  eventBodySchema({ name: ProductAnalyticsEventName.AnalyticsSchemaReady, params: noEventParamsSchema }),
  eventBodySchema({
    name: ProductAnalyticsEventName.AnalyticsActivationReady,
    params: z.strictObject({ activation_schema_version: z.enum(ProductAnalyticsActivationSchemaVersion) }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.ProjectInventoryLoaded,
    params: z.strictObject({ inventory_state: contentStateSchema }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.SessionActivityViewed,
    params: z.strictObject({ activity_state: contentStateSchema }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.SessionMessageSent,
    params: z.strictObject(messageSubmissionShape).refine(commandIsTyped),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.SessionCreatedWithMessage,
    params: z.strictObject({ ...messageSubmissionShape, workspace_kind: workspaceKindSchema }).refine(commandIsTyped),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.SessionCreationFailed,
    params: z.strictObject({
      failure_reason: z.enum(ProductAnalyticsSessionFailureReason),
      workspace_kind: workspaceKindSchema,
    }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.VoiceTranscriptionCompleted,
    params: z.strictObject({
      finish: z.enum(ProductAnalyticsVoiceFinish).optional(),
      mode: z.enum(ProductAnalyticsVoiceMode).optional(),
    }),
  }),
  eventBodySchema({ name: ProductAnalyticsEventName.SessionQuestionAnswered, params: noEventParamsSchema }),
  eventBodySchema({ name: ProductAnalyticsEventName.SessionQuestionRejected, params: noEventParamsSchema }),
  eventBodySchema({
    name: ProductAnalyticsEventName.SessionPermissionAnswered,
    params: z.strictObject({ decision: z.enum(ProductAnalyticsPermissionDecision) }),
  }),
  eventBodySchema({ name: ProductAnalyticsEventName.SessionAbortSucceeded, params: noEventParamsSchema }),
  eventBodySchema({
    name: ProductAnalyticsEventName.SessionDiffViewed,
    params: z.strictObject({ change_state: contentStateSchema }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.FeedbackPromptAnswered,
    params: z.strictObject({ answer: z.enum(ProductAnalyticsFeedbackAnswer), source: feedbackSourceSchema }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.PrivateFeedbackSent,
    params: z.strictObject({ input: z.enum(ProductAnalyticsFeedbackInput), source: feedbackSourceSchema }),
  }),
  eventBodySchema({ name: ProductAnalyticsEventName.OnboardingNeedHelpOpened, params: surfaceParamsSchema }),
  eventBodySchema({
    name: ProductAnalyticsEventName.OnboardingSupportLinkOpened,
    params: z.strictObject({ surface: onboardingSurfaceSchema, channel: z.enum(ProductAnalyticsSupportChannel) }),
  }),
  eventBodySchema({ name: ProductAnalyticsEventName.OnboardingWhyBridgeOpened, params: surfaceParamsSchema }),
  eventBodySchema({
    name: ProductAnalyticsEventName.BridgeInstallCommandCopied,
    params: installCommandParamsSchema,
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.BridgeInstallCommandShared,
    params: installCommandParamsSchema,
  }),
  eventBodySchema({ name: ProductAnalyticsEventName.BridgeRunCommandCopied, params: surfaceParamsSchema }),
  eventBodySchema({ name: ProductAnalyticsEventName.BridgeRunCommandShared, params: surfaceParamsSchema }),
  eventBodySchema({
    name: ProductAnalyticsEventName.ProductScreenViewed,
    params: z.strictObject({ screen: z.enum(ProductAnalyticsScreen) }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.PromptFilesSent,
    params: z.strictObject({
      file_count: z.enum(ProductAnalyticsFileCountBucket),
      source: z.enum(ProductAnalyticsFileSource),
    }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.HarnessInstallFinished,
    params: z.strictObject({ outcome: z.enum(ProductAnalyticsHarnessInstallOutcome) }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.TranscriptPromptsOpened,
    params: z.strictObject({ entry: z.enum(ProductAnalyticsPromptsEntry) }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.ComputerSwitched,
    params: z.strictObject({
      source: z.enum(ProductAnalyticsComputerSwitchSource),
      target_online: z.enum(ProductAnalyticsBoolean),
    }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.ComputerManaged,
    params: z.strictObject({ action: z.enum(ProductAnalyticsComputerManageAction) }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.SessionPinChanged,
    params: z.strictObject({ pinned: z.enum(ProductAnalyticsBoolean) }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.SideQuestionAsked,
    params: z.strictObject({
      harness: z.enum(ProductAnalyticsHarness),
      outcome: z.enum(ProductAnalyticsSideQuestionOutcome),
    }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.SessionMessageEdited,
    params: z.strictObject({
      harness: z.enum(ProductAnalyticsHarness),
      outcome: z.enum(ProductAnalyticsMessageEditOutcome),
    }),
  }),
  eventBodySchema({
    name: ProductAnalyticsEventName.SessionSentToSession,
    params: z.strictObject({
      harness: z.enum(ProductAnalyticsHarness),
      outcome: z.enum(ProductAnalyticsSessionSendOutcome),
    }),
  }),
]);

export type ProductAnalyticsEventBody = z.infer<typeof productAnalyticsEventBodySchema>;

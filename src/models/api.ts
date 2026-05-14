import { z } from "zod";

export type OAuthInitQuery = {
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
};

export type OAuthCallbackBody = {
  code: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
};

export type PasswordLoginBody = {
  email: string;
  password: string;
};

export type AppleNativeBody = {
  idToken: string;
  nonce?: string;
};

export type RefreshBody = {
  refreshToken: string;
};

export type UserProfile = {
  id: string;
  provider: string;
  providerUserId: string;
  providerUsername: string | null;
};

export type OAuthInitReply = {
  authUrl: string;
  state: string;
};

export const oauthClientTypeValues = [
  "bridge",
  "app",
  "bridge_macos",
  "bridge_windows",
  "bridge_linux",
  "app_ios",
  "app_android",
  "app_macos",
  "app_windows",
  "app_linux",
] as const;

export const oauthClientTypeSchema = z.enum(oauthClientTypeValues);
export type OAuthClientType = z.infer<typeof oauthClientTypeSchema>;

export const oauthInitBodySchema = z.object({
  clientType: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .trim()
        .toLowerCase()
        .replace(/[-\s]+/g, "_"),
    )
    .pipe(oauthClientTypeSchema),
});
export type OAuthInitBody = z.infer<typeof oauthInitBodySchema>;

export const oauthPendingInitBodySchema = oauthInitBodySchema;
export type OAuthPendingInitBody = OAuthInitBody;

export type OAuthPendingInitReply = {
  authUrl: string;
  state: string;
  userCode: string;
  expiresIn: number;
};

export type AuthSessionStatusPendingReply = {
  status: "pending";
};

export type AuthSessionStatusCompleteReply = {
  status: "complete";
  accessToken: string;
  refreshToken: string;
  user: UserProfile;
};

export type AuthSessionStatusDeniedReply = {
  status: "denied";
};

export type AuthSessionStatusExpiredReply = {
  status: "expired";
};

export type AuthSessionStatusErrorReply = {
  status: "error";
  message: string;
};

export type AuthSessionStatusReply =
  | AuthSessionStatusPendingReply
  | AuthSessionStatusCompleteReply
  | AuthSessionStatusDeniedReply
  | AuthSessionStatusExpiredReply
  | AuthSessionStatusErrorReply;

export type AuthTokensReply = {
  accessToken: string;
  refreshToken: string;
  user: UserProfile;
};

export type MeReply = {
  user: UserProfile;
};

export type SuccessReply = {
  success: true;
};

export type HealthReply = {
  status: "ok";
};

export type TranscribeReply = {
  text: string;
  dailySecondsRemaining: number;
};

export type GlossaryListReply = {
  words: string[];
};

export type GlossaryAddBody = {
  words: string[];
};

export type GlossaryAddReply = {
  added: string[];
};

export type GlossaryRemoveBody = {
  words: string[];
};

export type GlossaryRemoveReply = {
  removed: number;
};

export const registerTokenBodySchema = z.object({
  token: z.string().min(1),
  platform: z.enum(["ios", "android"]),
});
export type RegisterTokenBody = z.infer<typeof registerTokenBodySchema>;

export const notificationDataSchema = z.object({
  category: z.string(),
  eventType: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
});

export const sendNotificationBodySchema = z.object({
  category: z.enum(["ai_interaction", "session_message", "system_update"]),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(500),
  collapseKey: z.string().nullable(),
  data: notificationDataSchema.nullable().optional(),
});
export type SendNotificationBody = z.infer<typeof sendNotificationBodySchema>;

export const bridgeStatusBodySchema = z.object({
  userId: z.string().min(1),
  status: z.enum(["connected", "disconnected"]),
  timestamp: z.string(),
});
export type BridgeStatusBody = z.infer<typeof bridgeStatusBodySchema>;

export const generateMetadataBodySchema = z.object({
  firstMessage: z.string().min(1).max(500),
});
export type GenerateMetadataBody = z.infer<typeof generateMetadataBodySchema>;

export const generateMetadataReplySchema = z.object({
  title: z.string(),
  branchName: z.string(),
  worktreeName: z.string(),
});
export type GenerateMetadataReply = z.infer<typeof generateMetadataReplySchema>;

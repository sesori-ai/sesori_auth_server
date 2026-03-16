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

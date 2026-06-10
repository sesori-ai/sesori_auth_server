export enum OAuthProviderName {
  Github = "github",
  Google = "google",
  Apple = "apple",
}

// Provider key for email/password accounts. Must stay "email": it is part of
// the public API contract — clients (mobile app, bridge) parse it into a strict
// AuthProvider enum that only knows github/google/apple/email.
export const AUTH_PROVIDER_EMAIL = "email";

export type OAuthExchangeParams = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
};

export type OAuthIdentity = {
  providerUserId: string;
  providerUsername: string | null;
  email: string | null;
};

export type OAuthTokens = {
  token: string;
};

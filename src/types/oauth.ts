export enum OAuthProviderName {
  Github = "github",
  Google = "google",
  Apple = "apple",
}

export const AUTH_PROVIDER_PASSWORD = "password";

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

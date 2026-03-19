export enum OAuthProviderName {
  Github = "github",
  Google = "google",
}

export type OAuthExchangeParams = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
};

export type OAuthIdentity = {
  providerUserId: string;
  providerUsername: string | null;
};

export type OAuthTokens = {
  token: string;
};

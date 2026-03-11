import { ObjectId } from "mongodb";
import {
  decodeIdToken,
  exchangeCode as exchangeGoogleCode,
} from "../clients/google-client.js";
import {
  exchangeCode as exchangeGithubCode,
  fetchUser as fetchGithubUser,
} from "../clients/github-client.js";
import { refreshTokenPayloadSchema } from "../models/jwt.js";
import {
  findByProvider,
  findByUserId,
  upsert as upsertOauthAccount,
} from "../repositories/oauth-account-repo.js";
import {
  create as createUser,
  findById,
  incrementTokenVersion,
} from "../repositories/user-repo.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyToken,
} from "./token-service.js";

export class AuthServiceError extends Error {
  constructor(public readonly code: string, cause?: unknown) {
    super(code);
    this.cause = cause;
  }
}

type OAuthProvider = "github" | "google";

type AuthResult = {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
  };
};

export async function authenticateGithub(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<AuthResult> {
  let accessToken: string;

  try {
    const result = await exchangeGithubCode(
      params.code,
      params.codeVerifier,
      params.redirectUri,
      params.clientId,
      params.clientSecret
    );
    accessToken = result.accessToken;
  } catch (error) {
    if (error instanceof Error && error.message === "GITHUB_TOKEN_EXCHANGE_FAILED") {
      throw new AuthServiceError("GITHUB_TOKEN_EXCHANGE_FAILED", error);
    }
    if (error instanceof Error && error.message === "INVALID_GITHUB_TOKEN_RESPONSE") {
      throw new AuthServiceError("INVALID_GITHUB_TOKEN_RESPONSE", error);
    }
    throw error;
  }

  try {
    const githubUser = await fetchGithubUser(accessToken);
    return upsertFromOAuth({
      provider: "github",
      providerUserId: githubUser.id,
      providerUsername: githubUser.login,
      accessToken,
      refreshToken: undefined,
      persistRefreshToken: false,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "GITHUB_USER_FETCH_FAILED") {
      throw new AuthServiceError("GITHUB_USER_FETCH_FAILED", error);
    }
    if (error instanceof Error && error.message === "INVALID_GITHUB_USER_RESPONSE") {
      throw new AuthServiceError("INVALID_GITHUB_USER_RESPONSE", error);
    }
    throw error;
  }
}

export async function authenticateGoogle(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<AuthResult> {
  let tokenData: { accessToken: string; idToken: string; refreshToken?: string };

  try {
    tokenData = await exchangeGoogleCode(
      params.code,
      params.codeVerifier,
      params.redirectUri,
      params.clientId,
      params.clientSecret
    );
  } catch (error) {
    if (error instanceof Error && error.message === "GOOGLE_TOKEN_EXCHANGE_FAILED") {
      throw new AuthServiceError("GOOGLE_TOKEN_EXCHANGE_FAILED", error);
    }
    if (error instanceof Error && error.message === "INVALID_GOOGLE_TOKEN_RESPONSE") {
      throw new AuthServiceError("INVALID_GOOGLE_TOKEN_RESPONSE", error);
    }
    throw error;
  }

  let googleUser: { sub: string; name?: string };
  try {
    googleUser = decodeIdToken(tokenData.idToken);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "INVALID_GOOGLE_ID_TOKEN_PAYLOAD"
    ) {
      throw new AuthServiceError("INVALID_GOOGLE_ID_TOKEN_PAYLOAD", error);
    }
    throw new AuthServiceError("INVALID_GOOGLE_ID_TOKEN", error);
  }

  return upsertFromOAuth({
    provider: "google",
    providerUserId: googleUser.sub,
    providerUsername: googleUser.name ?? null,
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken,
    persistRefreshToken: tokenData.refreshToken !== undefined,
  });
}

export async function upsertFromOAuth(params: {
  provider: OAuthProvider;
  providerUserId: string;
  providerUsername: string | null;
  accessToken: string;
  refreshToken?: string;
  persistRefreshToken: boolean;
}): Promise<AuthResult> {
  const existingOauthAccount = await findByProvider(
    params.provider,
    params.providerUserId
  );

  let userId: ObjectId;
  let tokenVersion: number;
  if (existingOauthAccount) {
    userId = existingOauthAccount.userId;
    const user = await findById(userId);
    tokenVersion = user?.tokenVersion ?? 0;
  } else {
    const user = await createUser();
    userId = user._id;
    tokenVersion = 0;
  }

  await upsertOauthAccount({
    userId,
    provider: params.provider,
    providerUserId: params.providerUserId,
    providerUsername: params.providerUsername,
    accessToken: params.accessToken,
    refreshToken: params.persistRefreshToken
      ? (params.refreshToken ?? undefined)
      : undefined,
  });

  return signTokensForUser({
    userId: userId.toHexString(),
    provider: params.provider,
    providerUserId: params.providerUserId,
    providerUsername: params.providerUsername,
    tokenVersion,
  });
}

export function signTokensForUser(params: {
  userId: string;
  provider: string;
  providerUserId: string;
  providerUsername: string | null;
  tokenVersion: number;
}): AuthResult {
  const accessToken = signAccessToken({
    userId: params.userId,
    provider: params.provider,
    providerUserId: params.providerUserId,
  });
  const refreshToken = signRefreshToken({
    userId: params.userId,
    tokenVersion: params.tokenVersion,
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: params.userId,
      provider: params.provider,
      providerUserId: params.providerUserId,
      providerUsername: params.providerUsername,
    },
  };
}

export async function refreshAuthTokens(refreshToken: string): Promise<AuthResult> {
  let userId: string;
  let tokenVersion: number;
  try {
    const raw = verifyToken(refreshToken);
    const payload = refreshTokenPayloadSchema.parse(raw);
    userId = payload.userId;
    tokenVersion = payload.tokenVersion;
  } catch (error) {
    throw new AuthServiceError("UNAUTHORIZED", error);
  }

  const userObjectId = new ObjectId(userId);
  const user = await findById(userObjectId);
  if (!user) {
    throw new AuthServiceError("UNAUTHORIZED");
  }

  // Reject refresh tokens from before the last logout
  if (user.tokenVersion !== tokenVersion) {
    throw new AuthServiceError("UNAUTHORIZED");
  }

  const oauthAccount = await findByUserId(userObjectId);
  if (!oauthAccount) {
    throw new AuthServiceError("UNAUTHORIZED");
  }

  return signTokensForUser({
    userId,
    provider: oauthAccount.provider,
    providerUserId: oauthAccount.providerUserId,
    providerUsername: oauthAccount.providerUsername,
    tokenVersion: user.tokenVersion,
  });
}

export async function logoutUser(userId: string): Promise<void> {
  await incrementTokenVersion(new ObjectId(userId));
}

export async function findUserAuthProfile(userId: string): Promise<{
  id: string;
  provider: string;
  providerUserId: string;
  providerUsername: string | null;
} | null> {
  const userObjectId = new ObjectId(userId);
  const user = await findById(userObjectId);
  if (!user) {
    return null;
  }

  const oauthAccount = await findByUserId(userObjectId);
  if (!oauthAccount) {
    return null;
  }

  return {
    id: userId,
    provider: oauthAccount.provider,
    providerUserId: oauthAccount.providerUserId,
    providerUsername: oauthAccount.providerUsername,
  };
}

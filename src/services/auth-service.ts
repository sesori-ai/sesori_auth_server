import { ObjectId } from "mongodb";
import { GoogleClient } from "../clients/google-client.js";
import { GithubClient } from "../clients/github-client.js";
import { refreshTokenPayloadSchema } from "../models/jwt.js";
import { OAuthAccountRepository } from "../repositories/oauth-account-repo.js";
import { UserRepository } from "../repositories/user-repo.js";
import { TokenService } from "./token-service.js";

export class AuthServiceError extends Error {
  constructor(
    public readonly code: string,
    cause?: unknown,
  ) {
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

export class AuthService {
  private constructor() {}

  static async authenticateGithub(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<AuthResult> {
    let accessToken: string;

    try {
      const result = await GithubClient.exchangeCode(
        params.code,
        params.codeVerifier,
        params.redirectUri,
        params.clientId,
        params.clientSecret,
      );
      accessToken = result.accessToken;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "GITHUB_TOKEN_EXCHANGE_FAILED"
      ) {
        throw new AuthServiceError("GITHUB_TOKEN_EXCHANGE_FAILED", error);
      }
      if (
        error instanceof Error &&
        error.message === "INVALID_GITHUB_TOKEN_RESPONSE"
      ) {
        throw new AuthServiceError("INVALID_GITHUB_TOKEN_RESPONSE", error);
      }
      throw error;
    }

    try {
      const githubUser = await GithubClient.fetchUser(accessToken);
      return AuthService.upsertFromOAuth({
        provider: "github",
        providerUserId: githubUser.id,
        providerUsername: githubUser.login,
        accessToken,
        refreshToken: undefined,
        persistRefreshToken: false,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "GITHUB_USER_FETCH_FAILED"
      ) {
        throw new AuthServiceError("GITHUB_USER_FETCH_FAILED", error);
      }
      if (
        error instanceof Error &&
        error.message === "INVALID_GITHUB_USER_RESPONSE"
      ) {
        throw new AuthServiceError("INVALID_GITHUB_USER_RESPONSE", error);
      }
      throw error;
    }
  }

  static async authenticateGoogle(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<AuthResult> {
    let tokenData: {
      accessToken: string;
      idToken: string;
      refreshToken?: string;
    };

    try {
      tokenData = await GoogleClient.exchangeCode(
        params.code,
        params.codeVerifier,
        params.redirectUri,
        params.clientId,
        params.clientSecret,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "GOOGLE_TOKEN_EXCHANGE_FAILED"
      ) {
        throw new AuthServiceError("GOOGLE_TOKEN_EXCHANGE_FAILED", error);
      }
      if (
        error instanceof Error &&
        error.message === "INVALID_GOOGLE_TOKEN_RESPONSE"
      ) {
        throw new AuthServiceError("INVALID_GOOGLE_TOKEN_RESPONSE", error);
      }
      throw error;
    }

    let googleUser: { sub: string; name?: string };
    try {
      googleUser = GoogleClient.decodeIdToken(
        tokenData.idToken,
        params.clientId,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "INVALID_GOOGLE_ID_TOKEN_PAYLOAD"
      ) {
        throw new AuthServiceError("INVALID_GOOGLE_ID_TOKEN_PAYLOAD", error);
      }
      throw new AuthServiceError("INVALID_GOOGLE_ID_TOKEN", error);
    }

    return AuthService.upsertFromOAuth({
      provider: "google",
      providerUserId: googleUser.sub,
      providerUsername: googleUser.name ?? null,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      persistRefreshToken: tokenData.refreshToken !== undefined,
    });
  }

  static async upsertFromOAuth(params: {
    provider: OAuthProvider;
    providerUserId: string;
    providerUsername: string | null;
    accessToken: string;
    refreshToken?: string;
    persistRefreshToken: boolean;
  }): Promise<AuthResult> {
    const potentialUserId = new ObjectId();

    const account = await OAuthAccountRepository.upsert({
      potentialUserId,
      provider: params.provider,
      providerUserId: params.providerUserId,
      providerUsername: params.providerUsername,
      accessToken: params.accessToken,
      refreshToken: params.persistRefreshToken
        ? (params.refreshToken ?? undefined)
        : undefined,
    });

    const isNewUser = account.userId.equals(potentialUserId);
    let tokenVersion = 0;

    if (isNewUser) {
      await UserRepository.create(potentialUserId);
    } else {
      const user = await UserRepository.findById(account.userId);
      tokenVersion = user?.tokenVersion ?? 0;
    }

    return AuthService.signTokensForUser({
      userId: account.userId.toHexString(),
      provider: params.provider,
      providerUserId: params.providerUserId,
      providerUsername: params.providerUsername,
      tokenVersion,
    });
  }

  static signTokensForUser(params: {
    userId: string;
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
    tokenVersion: number;
  }): AuthResult {
    const accessToken = TokenService.signAccessToken({
      userId: params.userId,
      provider: params.provider,
      providerUserId: params.providerUserId,
    });
    const refreshToken = TokenService.signRefreshToken({
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

  static async refreshAuthTokens(refreshToken: string): Promise<AuthResult> {
    let userId: string;
    let tokenVersion: number;
    try {
      const raw = TokenService.verifyToken(refreshToken);
      const payload = refreshTokenPayloadSchema.parse(raw);
      userId = payload.userId;
      tokenVersion = payload.tokenVersion;
    } catch (error) {
      throw new AuthServiceError("UNAUTHORIZED", error);
    }

    const userObjectId = new ObjectId(userId);
    const user = await UserRepository.findById(userObjectId);
    if (!user) {
      throw new AuthServiceError("UNAUTHORIZED");
    }

    if (user.tokenVersion !== tokenVersion) {
      throw new AuthServiceError("UNAUTHORIZED");
    }

    const oauthAccount =
      await OAuthAccountRepository.findByUserId(userObjectId);
    if (!oauthAccount) {
      throw new AuthServiceError("UNAUTHORIZED");
    }

    return AuthService.signTokensForUser({
      userId,
      provider: oauthAccount.provider,
      providerUserId: oauthAccount.providerUserId,
      providerUsername: oauthAccount.providerUsername,
      tokenVersion: user.tokenVersion,
    });
  }

  static async logoutUser(userId: string): Promise<void> {
    await UserRepository.incrementTokenVersion(new ObjectId(userId));
  }

  static async revoke(userId: string): Promise<void> {
    await AuthService.logoutUser(userId);
  }

  static async findUserAuthProfile(userId: string): Promise<{
    id: string;
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
  } | null> {
    const userObjectId = new ObjectId(userId);
    const user = await UserRepository.findById(userObjectId);
    if (!user) {
      return null;
    }

    const oauthAccount =
      await OAuthAccountRepository.findByUserId(userObjectId);
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
}

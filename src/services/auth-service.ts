import { ObjectId } from "mongodb";
import { GoogleClient } from "../clients/google-client.js";
import { GithubClient } from "../clients/github-client.js";
import { BadGatewayError, UnauthenticatedError } from "../lib/errors.js";
import { refreshTokenPayloadSchema } from "../models/jwt.js";
import { OAuthAccountRepository } from "../repositories/oauth-account-repo.js";
import { UserRepository } from "../repositories/user-repo.js";
import { TokenService } from "./token-service.js";

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
      throw new BadGatewayError({ debugMessage: "GitHub token exchange failed", nestedError: error });
    }

    try {
      const githubUser = await GithubClient.fetchUser(accessToken);
      return AuthService.upsertFromOAuth({
        provider: "github",
        providerUserId: githubUser.id,
        providerUsername: githubUser.login,
      });
    } catch (error) {
      if (error instanceof BadGatewayError) throw error;
      throw new BadGatewayError({ debugMessage: "GitHub user fetch failed", nestedError: error });
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
      throw new BadGatewayError({ debugMessage: "Google token exchange failed", nestedError: error });
    }

    try {
      const googleUser = GoogleClient.decodeIdToken(tokenData.idToken, params.clientId);
      return AuthService.upsertFromOAuth({
        provider: "google",
        providerUserId: googleUser.sub,
        providerUsername: googleUser.name ?? null,
      });
    } catch (error) {
      if (error instanceof BadGatewayError) throw error;
      throw new BadGatewayError({ debugMessage: "Google ID token decode failed", nestedError: error });
    }
  }

  static async upsertFromOAuth(params: {
    provider: OAuthProvider;
    providerUserId: string;
    providerUsername: string | null;
  }): Promise<AuthResult> {
    const potentialUserId = new ObjectId();

    const account = await OAuthAccountRepository.upsert({
      potentialUserId,
      provider: params.provider,
      providerUserId: params.providerUserId,
      providerUsername: params.providerUsername,
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
      throw new UnauthenticatedError({ debugMessage: "Refresh token verification failed", nestedError: error });
    }

    const userObjectId = new ObjectId(userId);
    const user = await UserRepository.findById(userObjectId);
    if (!user) {
      throw new UnauthenticatedError({ debugMessage: "User not found for refresh token" });
    }

    if (user.tokenVersion !== tokenVersion) {
      throw new UnauthenticatedError({ debugMessage: "Token version mismatch (revoked)" });
    }

    const oauthAccount = await OAuthAccountRepository.findByUserId(userObjectId);
    if (!oauthAccount) {
      throw new UnauthenticatedError({ debugMessage: "OAuth account not found for refresh token" });
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

    const oauthAccount = await OAuthAccountRepository.findByUserId(userObjectId);
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

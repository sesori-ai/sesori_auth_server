import type { OAuthClient } from "../clients/auth/oauth-client.js";
import { OAuthProviderName, type OAuthExchangeParams } from "../types/oauth.js";
import { BadGatewayError, UnauthenticatedError } from "../lib/errors.js";
import { refreshTokenPayloadSchema } from "../models/jwt.js";
import { OAuthAccountRepository } from "../repositories/oauth-account-repo.js";
import { UserRepository } from "../repositories/user-repo.js";
import { TokenService } from "./token-service.js";

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
  readonly #tokenService: TokenService;
  readonly #userRepo: UserRepository;
  readonly #oauthAccountRepo: OAuthAccountRepository;

  constructor(deps: {
    tokenService: TokenService;
    userRepo: UserRepository;
    oauthAccountRepo: OAuthAccountRepository;
  }) {
    this.#tokenService = deps.tokenService;
    this.#userRepo = deps.userRepo;
    this.#oauthAccountRepo = deps.oauthAccountRepo;
  }

  async authenticateOAuth(
    providerName: OAuthProviderName,
    provider: OAuthClient,
    params: OAuthExchangeParams,
  ): Promise<AuthResult> {
    try {
      const identity = await provider.authenticate(params);
      return this.#upsertFromOAuth({
        provider: providerName,
        providerUserId: identity.providerUserId,
        providerUsername: identity.providerUsername,
      });
    } catch (error) {
      if (error instanceof BadGatewayError) throw error;
      throw new BadGatewayError({
        debugMessage: `${providerName} authentication failed`,
        nestedError: error,
      });
    }
  }

  async #upsertFromOAuth(params: {
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
  }): Promise<AuthResult> {
    const { account, potentialUserId } = await this.#oauthAccountRepo.upsert({
      provider: params.provider,
      providerUserId: params.providerUserId,
      providerUsername: params.providerUsername,
    });

    const accountUserId = account.userId.toHexString();
    const isNewUser = accountUserId === potentialUserId;
    let tokenVersion = 0;

    if (isNewUser) {
      await this.#userRepo.create(potentialUserId);
    } else {
      const user = await this.#userRepo.findById(accountUserId);
      tokenVersion = user?.tokenVersion ?? 0;
    }

    return this.#signTokensForUser({
      userId: accountUserId,
      provider: params.provider,
      providerUserId: params.providerUserId,
      providerUsername: params.providerUsername,
      tokenVersion,
    });
  }

  #signTokensForUser(params: {
    userId: string;
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
    tokenVersion: number;
  }): AuthResult {
    const accessToken = this.#tokenService.signAccessToken({
      userId: params.userId,
      provider: params.provider,
      providerUserId: params.providerUserId,
    });
    const refreshToken = this.#tokenService.signRefreshToken({
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

  async refreshAuthTokens(refreshToken: string): Promise<AuthResult> {
    let userId: string;
    let tokenVersion: number;
    try {
      const raw = this.#tokenService.verifyRefreshToken(refreshToken);
      const result = refreshTokenPayloadSchema.safeParse(raw);
      if (!result.success) {
        throw new UnauthenticatedError({
          debugMessage: "Refresh token payload invalid",
          nestedError: result.error.issues,
        });
      }
      userId = result.data.userId;
      tokenVersion = result.data.tokenVersion;
    } catch (error) {
      throw new UnauthenticatedError({ debugMessage: "Refresh token verification failed", nestedError: error });
    }

    const [user, oauthAccount] = await Promise.all([
      this.#userRepo.findById(userId),
      this.#oauthAccountRepo.findByUserId(userId),
    ]);

    if (!user) {
      throw new UnauthenticatedError({ debugMessage: "User not found for refresh token" });
    }

    if (user.tokenVersion !== tokenVersion) {
      throw new UnauthenticatedError({ debugMessage: "Token version mismatch (revoked)" });
    }

    if (!oauthAccount) {
      throw new UnauthenticatedError({ debugMessage: "OAuth account not found for refresh token" });
    }

    return this.#signTokensForUser({
      userId,
      provider: oauthAccount.provider,
      providerUserId: oauthAccount.providerUserId,
      providerUsername: oauthAccount.providerUsername,
      tokenVersion: user.tokenVersion,
    });
  }

  async logoutUser(userId: string): Promise<void> {
    await this.#userRepo.incrementTokenVersion(userId);
  }

  // TODO: revoke() currently delegates to logoutUser(). Will diverge when relay
  // integration lands (notify relay, invalidate bridge tokens, etc.)
  async revoke(userId: string): Promise<void> {
    await this.logoutUser(userId);
  }

  async findUserAuthProfile(userId: string): Promise<{
    id: string;
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
  } | null> {
    const [user, oauthAccount] = await Promise.all([
      this.#userRepo.findById(userId),
      this.#oauthAccountRepo.findByUserId(userId),
    ]);

    if (!user || !oauthAccount) {
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

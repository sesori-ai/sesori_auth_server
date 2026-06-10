import type { OAuthClient } from "../clients/auth/oauth-client.js";
import {
  AUTH_PROVIDER_EMAIL,
  OAuthProviderName,
  type OAuthExchangeParams,
  type OAuthIdentity,
} from "../types/oauth.js";
import { BadGatewayError, UnauthenticatedError } from "../lib/errors.js";
import { refreshTokenPayloadSchema } from "../models/jwt.js";
import { OAuthAccountRepository } from "../repositories/oauth-account-repo.js";
import { PasswordAccountRepository } from "../repositories/password-account-repo.js";
import { UserRepository } from "../repositories/user-repo.js";
import type { DeviceTokenRepository } from "../repositories/device-token-repo.js";
import type { BridgeService } from "./bridge-service.js";
import { TokenService } from "./token-service.js";
import argon2 from "argon2";

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
  readonly #passwordAccountRepo: PasswordAccountRepository;
  readonly #deviceTokenRepo?: DeviceTokenRepository;
  readonly #bridgeService: BridgeService;

  constructor(deps: {
    tokenService: TokenService;
    userRepo: UserRepository;
    oauthAccountRepo: OAuthAccountRepository;
    passwordAccountRepo: PasswordAccountRepository;
    deviceTokenRepo?: DeviceTokenRepository;
    bridgeService: BridgeService;
  }) {
    this.#tokenService = deps.tokenService;
    this.#userRepo = deps.userRepo;
    this.#oauthAccountRepo = deps.oauthAccountRepo;
    this.#passwordAccountRepo = deps.passwordAccountRepo;
    this.#deviceTokenRepo = deps.deviceTokenRepo;
    this.#bridgeService = deps.bridgeService;
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
        email: identity.email,
      });
    } catch (error) {
      if (error instanceof BadGatewayError) throw error;
      throw new BadGatewayError({
        debugMessage: `${providerName} authentication failed`,
        nestedError: error,
      });
    }
  }

  // Caller (apple-native route) has already verified the id_token signature,
  // audience, expiration, and nonce binding via AppleNativeVerifier.
  async authenticateAppleNative(identity: OAuthIdentity): Promise<AuthResult> {
    return this.#upsertFromOAuth({
      provider: OAuthProviderName.Apple,
      providerUserId: identity.providerUserId,
      providerUsername: identity.providerUsername,
      email: identity.email,
    });
  }

  // Dummy hash for timing-equalization on unknown-email path.
  // argon2.verify may throw on malformed inputs; we catch and ignore since we only care about elapsed wall time.
  static readonly DUMMY_ARGON2_HASH =
    "$argon2id$v=19$m=65536,t=3,p=4$/R5dXiOwOc+wCU/mwiMovw$v7azh64R/DkyfBjwAUCJLLCZdVNXwKQXtvcq7+EmqLc";

  async authenticatePassword(email: string, password: string): Promise<AuthResult> {
    const account = await this.#passwordAccountRepo.findByEmail(email);

    if (!account) {
      try {
        await argon2.verify(AuthService.DUMMY_ARGON2_HASH, password);
      } catch {
        /* timing-only */
      }
      throw new UnauthenticatedError({ debugMessage: "Invalid email or password" });
    }

    const valid = await argon2.verify(account.passwordHash, password);
    if (!valid) {
      throw new UnauthenticatedError({ debugMessage: "Invalid email or password" });
    }

    if (argon2.needsRehash(account.passwordHash)) {
      const newHash = await argon2.hash(password, { type: argon2.argon2id });
      await this.#passwordAccountRepo.updatePasswordHash(account.userId.toHexString(), newHash);
    }

    const user = await this.#userRepo.findById(account.userId.toHexString());
    if (!user) {
      throw new UnauthenticatedError({ debugMessage: "Invalid email or password" });
    }

    return this.#signTokensForUser({
      userId: account.userId.toHexString(),
      provider: AUTH_PROVIDER_EMAIL,
      providerUserId: account.userId.toHexString(),
      providerUsername: account.email,
      tokenVersion: user.tokenVersion ?? 0,
    });
  }

  async #upsertFromOAuth(params: {
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
    email: string | null;
  }): Promise<AuthResult> {
    const { account, potentialUserId } = await this.#oauthAccountRepo.upsert({
      provider: params.provider,
      providerUserId: params.providerUserId,
      providerUsername: params.providerUsername,
      email: params.email,
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
      providerUsername: account.providerUsername,
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

    const [user, oauthAccount, passwordAccount] = await Promise.all([
      this.#userRepo.findById(userId),
      this.#oauthAccountRepo.findByUserId(userId),
      this.#passwordAccountRepo.findByUserId(userId),
    ]);

    if (!user) {
      throw new UnauthenticatedError({ debugMessage: "User not found for refresh token" });
    }

    if (user.tokenVersion !== tokenVersion) {
      throw new UnauthenticatedError({ debugMessage: "Token version mismatch (revoked)" });
    }

    if (oauthAccount) {
      return this.#signTokensForUser({
        userId,
        provider: oauthAccount.provider,
        providerUserId: oauthAccount.providerUserId,
        providerUsername: oauthAccount.providerUsername,
        tokenVersion: user.tokenVersion,
      });
    }

    if (passwordAccount) {
      return this.#signTokensForUser({
        userId,
        provider: AUTH_PROVIDER_EMAIL,
        providerUserId: userId,
        providerUsername: passwordAccount.email,
        tokenVersion: user.tokenVersion,
      });
    }

    throw new UnauthenticatedError({ debugMessage: "Auth account not found for refresh token" });
  }

  async logoutUser(userId: string): Promise<void> {
    await this.#userRepo.incrementTokenVersion(userId);
    if (this.#deviceTokenRepo) {
      await this.#deviceTokenRepo.deleteAllForUser(userId);
    }
  }

  async revoke(userId: string): Promise<void> {
    // Bridges first, deliberately: if bridge revocation throws, tokenVersion
    // has not been bumped yet, so the client still holds valid tokens and can
    // retry the whole flow without partial state. Swapping the order would
    // leave a failed revoke with dead tokens AND lingering bridges.
    // The contract is pinned by tests/auth/revoke.test.ts.
    await this.#bridgeService.revokeAllForUser(userId);
    await this.logoutUser(userId);
  }

  async findUserAuthProfile(userId: string): Promise<{
    id: string;
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
  } | null> {
    const [user, oauthAccount, passwordAccount] = await Promise.all([
      this.#userRepo.findById(userId),
      this.#oauthAccountRepo.findByUserId(userId),
      this.#passwordAccountRepo.findByUserId(userId),
    ]);

    if (!user) {
      return null;
    }

    if (oauthAccount) {
      return {
        id: userId,
        provider: oauthAccount.provider,
        providerUserId: oauthAccount.providerUserId,
        providerUsername: oauthAccount.providerUsername,
      };
    }

    if (passwordAccount) {
      return {
        id: userId,
        provider: AUTH_PROVIDER_EMAIL,
        providerUserId: userId,
        providerUsername: passwordAccount.email,
      };
    }

    return null;
  }
}

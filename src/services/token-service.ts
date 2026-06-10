import jwt from "jsonwebtoken";
import {
  type AccessTokenPayload,
  accessTokenPayloadSchema,
  type RefreshTokenPayload,
  refreshTokenPayloadSchema,
} from "../models/jwt.js";
import { InternalServerError } from "../lib/errors.js";

// Short-lived: access tokens are stateless, so expiry is the only thing that
// invalidates them (logout/revoke only cuts off refresh via tokenVersion).
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export class TokenService {
  readonly #privateKey: string;
  readonly #publicKey: string;

  constructor(privateKeyPem: string, publicKeyPem: string) {
    this.#privateKey = privateKeyPem.replace(/\\n/g, "\n");
    this.#publicKey = publicKeyPem.replace(/\\n/g, "\n");
  }

  // Password users sign access tokens with provider="password" and providerUserId=user._id.toString().
  // providerUserId stays as the 24-char hex ObjectId string so we avoid putting email into the JWT.
  signAccessToken(payload: { userId: string; provider: string; providerUserId: string }): string {
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = ACCESS_TOKEN_TTL_SECONDS;

    const tokenPayloadResult = accessTokenPayloadSchema.safeParse({
      tokenType: "access",
      userId: payload.userId,
      provider: payload.provider,
      providerUserId: payload.providerUserId,
      iss: "auth-backend",
      aud: "mobile",
      iat: now,
      exp: now + expiresIn,
    });
    if (!tokenPayloadResult.success) {
      throw new InternalServerError({
        debugMessage: "Access token payload validation failed",
        nestedError: tokenPayloadResult.error.issues,
      });
    }
    const tokenPayload: AccessTokenPayload = tokenPayloadResult.data;

    return jwt.sign(tokenPayload, this.#privateKey, {
      algorithm: "RS256",
    });
  }

  signRefreshToken(payload: { userId: string; tokenVersion: number }): string {
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = REFRESH_TOKEN_TTL_SECONDS;

    const tokenPayloadResult = refreshTokenPayloadSchema.safeParse({
      tokenType: "refresh",
      userId: payload.userId,
      tokenVersion: payload.tokenVersion,
      iss: "auth-backend",
      aud: "mobile",
      iat: now,
      exp: now + expiresIn,
    });
    if (!tokenPayloadResult.success) {
      throw new InternalServerError({
        debugMessage: "Refresh token payload validation failed",
        nestedError: tokenPayloadResult.error.issues,
      });
    }
    const tokenPayload: RefreshTokenPayload = tokenPayloadResult.data;

    return jwt.sign(tokenPayload, this.#privateKey, {
      algorithm: "RS256",
    });
  }

  verifyAccessToken(token: string): unknown {
    return this.#verifyToken(token, "mobile");
  }

  verifyRefreshToken(token: string): unknown {
    return this.#verifyToken(token, "mobile");
  }

  getPublicKey(): string {
    return this.#publicKey;
  }

  #verifyToken(token: string, audience: string): unknown {
    return jwt.verify(token, this.#publicKey, {
      algorithms: ["RS256"],
      issuer: "auth-backend",
      audience,
    });
  }
}

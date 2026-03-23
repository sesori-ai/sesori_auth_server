import jwt from "jsonwebtoken";
import {
  type AccessTokenPayload,
  accessTokenPayloadSchema,
  type BridgeTokenPayload,
  bridgeTokenPayloadSchema,
  type RefreshTokenPayload,
  refreshTokenPayloadSchema,
} from "../models/jwt.js";
import { InternalServerError } from "../lib/errors.js";

export class TokenService {
  readonly #privateKey: string;
  readonly #publicKey: string;

  constructor(privateKeyPem: string, publicKeyPem: string) {
    this.#privateKey = privateKeyPem.replace(/\\n/g, "\n");
    this.#publicKey = publicKeyPem.replace(/\\n/g, "\n");
  }

  signAccessToken(payload: { userId: string; provider: string; providerUserId: string }): string {
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 15 * 60;

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
    const expiresIn = 30 * 24 * 60 * 60;

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

  // TODO(relay): Bridge tokens for relay integration. Wire to a route when relay service is implemented. Remove if relay is dropped.
  signBridgeToken(payload: { userId: string }): string {
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 24 * 60 * 60;

    const tokenPayloadResult = bridgeTokenPayloadSchema.safeParse({
      tokenType: "bridge",
      userId: payload.userId,
      iss: "auth-backend",
      aud: "bridge",
      iat: now,
      exp: now + expiresIn,
    });
    if (!tokenPayloadResult.success) {
      throw new InternalServerError({
        debugMessage: "Bridge token payload validation failed",
        nestedError: tokenPayloadResult.error.issues,
      });
    }
    const tokenPayload: BridgeTokenPayload = tokenPayloadResult.data;

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

  verifyBridgeToken(token: string): unknown {
    return this.#verifyToken(token, "bridge");
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

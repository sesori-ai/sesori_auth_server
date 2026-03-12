import jwt from "jsonwebtoken";
import {
  type AccessTokenPayload,
  accessTokenPayloadSchema,
  type BridgeTokenPayload,
  bridgeTokenPayloadSchema,
  type RefreshTokenPayload,
  refreshTokenPayloadSchema,
} from "../models/jwt.js";

export class TokenService {
  private static privateKey: string | null = null;
  private static publicKey: string | null = null;

  private constructor() {}

  static setKeys(privateKeyPem: string, publicKeyPem: string): void {
    TokenService.privateKey = privateKeyPem.replace(/\\n/g, "\n");
    TokenService.publicKey = publicKeyPem.replace(/\\n/g, "\n");
  }

  static signAccessToken(payload: {
    userId: string;
    provider: string;
    providerUserId: string;
  }): string {
    if (!TokenService.privateKey) {
      throw new Error("Private key not loaded. Call setKeys() first.");
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 15 * 60;

    const tokenPayload: AccessTokenPayload = accessTokenPayloadSchema.parse({
      tokenType: "access",
      userId: payload.userId,
      provider: payload.provider,
      providerUserId: payload.providerUserId,
      iss: "auth-backend",
      aud: "mobile",
      iat: now,
      exp: now + expiresIn,
    });

    return jwt.sign(tokenPayload, TokenService.privateKey, {
      algorithm: "RS256",
    });
  }

  static signRefreshToken(payload: {
    userId: string;
    tokenVersion: number;
  }): string {
    if (!TokenService.privateKey) {
      throw new Error("Private key not loaded. Call setKeys() first.");
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 30 * 24 * 60 * 60;

    const tokenPayload: RefreshTokenPayload = refreshTokenPayloadSchema.parse({
      tokenType: "refresh",
      userId: payload.userId,
      tokenVersion: payload.tokenVersion,
      iss: "auth-backend",
      aud: "mobile",
      iat: now,
      exp: now + expiresIn,
    });

    return jwt.sign(tokenPayload, TokenService.privateKey, {
      algorithm: "RS256",
    });
  }

  static signBridgeToken(payload: { userId: string }): string {
    if (!TokenService.privateKey) {
      throw new Error("Private key not loaded. Call setKeys() first.");
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 24 * 60 * 60;

    const tokenPayload: BridgeTokenPayload = bridgeTokenPayloadSchema.parse({
      tokenType: "bridge",
      userId: payload.userId,
      iss: "auth-backend",
      aud: "bridge",
      iat: now,
      exp: now + expiresIn,
    });

    return jwt.sign(tokenPayload, TokenService.privateKey, {
      algorithm: "RS256",
    });
  }

  static verifyToken(token: string): Record<string, unknown> {
    if (!TokenService.publicKey) {
      throw new Error("Public key not loaded. Call setKeys() first.");
    }

    return jwt.verify(token, TokenService.publicKey, {
      algorithms: ["RS256"],
      issuer: "auth-backend",
    }) as Record<string, unknown>;
  }

  static getPublicKey(): string {
    if (!TokenService.publicKey) {
      throw new Error("Public key not loaded. Call setKeys() first.");
    }

    return TokenService.publicKey;
  }
}

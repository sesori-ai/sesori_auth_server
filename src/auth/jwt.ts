import jwt from "jsonwebtoken";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  accessTokenPayloadSchema,
  refreshTokenPayloadSchema,
  bridgeTokenPayloadSchema,
  type AccessTokenPayload,
  type RefreshTokenPayload,
  type BridgeTokenPayload,
} from "./token-schemas.js";

let privateKey: string | null = null;
let publicKey: string | null = null;

/**
 * Generates an RS256 key pair and writes to disk.
 * For initial setup only.
 */
export function generateKeyPair(
  privatePath: string,
  publicPath: string
): void {
  const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync(
    "rsa",
    {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: "spki",
        format: "pem",
      },
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
      },
    }
  );

  fs.writeFileSync(privatePath, priv);
  fs.writeFileSync(publicPath, pub);
}

/**
 * Loads RS256 keys from disk and caches them in module-level variables.
 */
export function loadKeys(privatePath: string, publicPath: string): void {
  privateKey = fs.readFileSync(privatePath, "utf-8");
  publicKey = fs.readFileSync(publicPath, "utf-8");
}

/**
 * Signs an access token with RS256.
 * Expiry: 15 minutes
 */
export function signAccessToken(payload: {
  userId: string;
  provider: string;
  providerUserId: string;
}): string {
  if (!privateKey) {
    throw new Error("Private key not loaded. Call loadKeys() first.");
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 15 * 60; // 15 minutes

  const tokenPayload: AccessTokenPayload = {
    userId: payload.userId,
    provider: payload.provider,
    providerUserId: payload.providerUserId,
    iss: "auth-backend",
    aud: "mobile",
    iat: now,
    exp: now + expiresIn,
  };

  return jwt.sign(tokenPayload, privateKey, { algorithm: "RS256" });
}

/**
 * Signs a refresh token with RS256.
 * Expiry: 30 days
 */
export function signRefreshToken(payload: { userId: string }): string {
  if (!privateKey) {
    throw new Error("Private key not loaded. Call loadKeys() first.");
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 30 * 24 * 60 * 60; // 30 days

  const tokenPayload: RefreshTokenPayload = {
    userId: payload.userId,
    iss: "auth-backend",
    aud: "mobile",
    iat: now,
    exp: now + expiresIn,
  };

  return jwt.sign(tokenPayload, privateKey, { algorithm: "RS256" });
}

/**
 * Signs a bridge token with RS256.
 * Expiry: 24 hours
 */
export function signBridgeToken(payload: { userId: string }): string {
  if (!privateKey) {
    throw new Error("Private key not loaded. Call loadKeys() first.");
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 24 * 60 * 60; // 24 hours

  const tokenPayload: BridgeTokenPayload = {
    userId: payload.userId,
    iss: "auth-backend",
    aud: "bridge",
    iat: now,
    exp: now + expiresIn,
  };

  return jwt.sign(tokenPayload, privateKey, { algorithm: "RS256" });
}

/**
 * Verifies a JWT token with the public key.
 * Returns the decoded payload or throws if invalid.
 */
export function verifyToken(token: string): Record<string, unknown> {
  if (!publicKey) {
    throw new Error("Public key not loaded. Call loadKeys() first.");
  }

  return jwt.verify(token, publicKey, { algorithms: ["RS256"] }) as Record<
    string,
    unknown
  >;
}

/**
 * Returns the loaded public key string for distribution to relay.
 */
export function getPublicKey(): string {
  if (!publicKey) {
    throw new Error("Public key not loaded. Call loadKeys() first.");
  }

  return publicKey;
}

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import jwt from "jsonwebtoken";
import {
  type AccessTokenPayload,
  accessTokenPayloadSchema,
  type BridgeTokenPayload,
  bridgeTokenPayloadSchema,
  type RefreshTokenPayload,
  refreshTokenPayloadSchema,
} from "../models/jwt.js";

let privateKey: string | null = null;
let publicKey: string | null = null;

export function generateKeyPair(privatePath: string, publicPath: string): void {
  const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  fs.writeFileSync(privatePath, priv, { mode: 0o600 });
  fs.writeFileSync(publicPath, pub);
}

export function loadKeys(privatePath: string, publicPath: string): void {
  privateKey = fs.readFileSync(privatePath, "utf-8");
  publicKey = fs.readFileSync(publicPath, "utf-8");
}

export function signAccessToken(payload: {
  userId: string;
  provider: string;
  providerUserId: string;
}): string {
  if (!privateKey) {
    throw new Error("Private key not loaded. Call loadKeys() first.");
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

  return jwt.sign(tokenPayload, privateKey, { algorithm: "RS256" });
}

export function signRefreshToken(payload: { userId: string; tokenVersion: number }): string {
  if (!privateKey) {
    throw new Error("Private key not loaded. Call loadKeys() first.");
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

  return jwt.sign(tokenPayload, privateKey, { algorithm: "RS256" });
}

export function signBridgeToken(payload: { userId: string }): string {
  if (!privateKey) {
    throw new Error("Private key not loaded. Call loadKeys() first.");
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

  return jwt.sign(tokenPayload, privateKey, { algorithm: "RS256" });
}

export function verifyToken(token: string): Record<string, unknown> {
  if (!publicKey) {
    throw new Error("Public key not loaded. Call loadKeys() first.");
  }

  return jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer: "auth-backend",
  }) as Record<
    string,
    unknown
  >;
}

export function getPublicKey(): string {
  if (!publicKey) {
    throw new Error("Public key not loaded. Call loadKeys() first.");
  }

  return publicKey;
}

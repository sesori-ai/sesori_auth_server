import { closeDb, oAuthDbClient } from "../../src/db/db-client.js";
import { DatabaseAccessor } from "../../src/db/database-accessor.js";
import { buildApp } from "../../src/server.js";
import { TokenService } from "../../src/services/token-service.js";
import { ObjectId } from "mongodb";
import * as crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { FastifyInstance } from "fastify";

export type TestUser = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  provider: string;
  providerUserId: string;
};

export type TestContext = {
  app: FastifyInstance;
  cleanup: () => Promise<void>;
  createUser: (opts?: {
    provider?: string;
    providerUserId?: string;
  }) => Promise<TestUser>;
  createExpiredRefreshToken: (userId: string) => string;
};

export async function createTestApp(): Promise<TestContext> {
  const { privateKey: privPem, publicKey: pubPem } = crypto.generateKeyPairSync(
    "rsa",
    {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    },
  );

  const mongoUri =
    process.env.MONGODB_URI_TEST ??
    "mongodb://localhost:27017/auth-backend-test";
  process.env.MONGODB_URI = mongoUri;
  process.env.JWT_PRIVATE_KEY = privPem;
  process.env.JWT_PUBLIC_KEY = pubPem;
  process.env.GITHUB_CLIENT_ID ??= "test-github-client-id";
  process.env.GITHUB_CLIENT_SECRET ??= "test-github-client-secret";
  process.env.GOOGLE_CLIENT_ID ??= "test-google-client-id";
  process.env.GOOGLE_CLIENT_SECRET ??= "test-google-client-secret";
  process.env.RELAY_URL ??= "ws://localhost:8080";

  TokenService.setKeys(privPem, pubPem);

  const db = oAuthDbClient.getDatabase();
  await db.dropDatabase();
  await DatabaseAccessor.ensureIndexes();

  const app = await buildApp();
  await app.ready();

  async function createUser(
    opts: { provider?: string; providerUserId?: string } = {},
  ): Promise<TestUser> {
    const provider = opts.provider ?? "github";
    const providerUserId = opts.providerUserId ?? new ObjectId().toHexString();
    const userId = new ObjectId();
    const now = new Date();

    await DatabaseAccessor.users().insertOne({
      _id: userId,
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    await DatabaseAccessor.oauthAccounts().insertOne({
      _id: new ObjectId(),
      userId,
      provider,
      providerUserId,
      providerUsername: `testuser_${userId.toHexString()}`,
      accessToken: null,
      refreshToken: null,
      createdAt: now,
      updatedAt: now,
    });

    const userIdStr = userId.toHexString();
    const accessToken = TokenService.signAccessToken({
      userId: userIdStr,
      provider,
      providerUserId,
    });
    const refreshToken = TokenService.signRefreshToken({
      userId: userIdStr,
      tokenVersion: 0,
    });

    return {
      userId: userIdStr,
      accessToken,
      refreshToken,
      provider,
      providerUserId,
    };
  }

  function createExpiredRefreshToken(userId: string): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      {
        tokenType: "refresh",
        userId,
        tokenVersion: 0,
        iss: "auth-backend",
        aud: "mobile",
        iat: now - 7200,
        exp: now - 3600,
      },
      privPem,
      { algorithm: "RS256" },
    );
  }

  async function cleanup(): Promise<void> {
    await app.close();
    const db = oAuthDbClient.getDatabase();
    await db.dropDatabase();
    await closeDb();
  }

  return { app, cleanup, createUser, createExpiredRefreshToken };
}

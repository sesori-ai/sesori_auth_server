import * as crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { GithubClient } from "../../src/clients/auth/github-client.js";
import { GoogleClient } from "../../src/clients/auth/google-client.js";
import type { OAuthClient } from "../../src/clients/auth/oauth-client.js";
import { OpenAIClient } from "../../src/clients/openai-client.js";
import type { User, OAuthAccount } from "../../src/models/documents.js";
import { MongoDbAccessor } from "../../src/db/mongo-db-accessor.js";
import { MongoDbConnector } from "../../src/db/mongo-db-connector.js";
import { MongoDbDatabase, AuthDbCollection } from "../../src/types/mongo.js";
import { StateStore } from "../../src/lib/state-store.js";
import { DailyUsageRepository } from "../../src/repositories/daily-usage-repo.js";
import { DeviceTokenRepository } from "../../src/repositories/device-token-repo.js";
import { GlossaryEntryRepository } from "../../src/repositories/glossary-entry-repo.js";
import { OAuthAccountRepository } from "../../src/repositories/oauth-account-repo.js";
import { UserRepository } from "../../src/repositories/user-repo.js";
import { buildApp } from "../../src/server.js";
import { AuthService } from "../../src/services/auth-service.js";
import { NotificationService } from "../../src/services/notification-service.js";
import { TokenService } from "../../src/services/token-service.js";
import { VoiceService } from "../../src/services/voice-service.js";
import { loadConfig } from "../../src/config.js";

export type TestUser = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  provider: string;
  providerUserId: string;
};

export type TestContext = {
  app: FastifyInstance;
  /**
   * Exposed for test scenarios that require direct DB access (e.g., seeding quota state
   * or verifying persisted documents). Prefer API-based assertions where possible;
   * direct DB access can mask validation or business-logic bugs.
   */
  dbAccessor: MongoDbAccessor;
  tokenService: TokenService;
  cleanup: () => Promise<void>;
  createUser: (opts?: { provider?: string; providerUserId?: string }) => Promise<TestUser>;
  createExpiredRefreshToken: (userId: string) => string;
  createExpiredAccessToken: (opts: { userId: string; provider: string; providerUserId: string }) => string;
};

export type TestAppOverrides = {
  githubClient?: OAuthClient;
  googleClient?: OAuthClient;
  notificationService?: NotificationService;
};

export type { OAuthClient };

export async function createTestApp(overrides?: TestAppOverrides): Promise<TestContext> {
  const { privateKey: privPem, publicKey: pubPem } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const mongoUri = process.env.MONGODB_URI_TEST ?? "mongodb://localhost:27017/auth-backend-test";
  process.env.MONGODB_URI = mongoUri;
  process.env.JWT_PRIVATE_KEY = privPem;
  process.env.JWT_PUBLIC_KEY = pubPem;
  process.env.GITHUB_CLIENT_ID ??= "test-github-client-id";
  process.env.GITHUB_CLIENT_SECRET ??= "test-github-client-secret";
  process.env.GOOGLE_CLIENT_ID ??= "test-google-client-id";
  process.env.GOOGLE_CLIENT_SECRET ??= "test-google-client-secret";
  process.env.ALLOWED_REDIRECT_URIS ??= "myapp://oauth/callback";
  process.env.RELAY_URL ??= "ws://localhost:8080";
  process.env.RELAY_WEBHOOK_SECRET ??= "test-relay-secret";
  process.env.OPENAI_API_KEY ??= "test-openai-api-key";
  process.env.OPENAI_TRANSCRIPTION_MODEL ??= "gpt-4o-mini-transcribe";

  const config = loadConfig();

  const dbConnector = new MongoDbConnector({ connectionString: mongoUri });
  const dbAccessor = new MongoDbAccessor(dbConnector);

  await dbAccessor.getDb(MongoDbDatabase.Auth).dropDatabase();
  await dbAccessor.ensureIndexes();

  const userRepo = new UserRepository(dbAccessor);
  const oauthAccountRepo = new OAuthAccountRepository(dbAccessor);
  const glossaryRepo = new GlossaryEntryRepository(dbAccessor);
  const dailyUsageRepo = new DailyUsageRepository(dbAccessor);
  const deviceTokenRepo = new DeviceTokenRepository(dbAccessor);

  const tokenService = new TokenService(privPem, pubPem);
  const stateStore = new StateStore();

  const openai = new OpenAIClient({ apiKey: "test-key", model: "gpt-4o-mini-transcribe" });
  const githubClient = overrides?.githubClient ?? new GithubClient();
  const googleClient = overrides?.googleClient ?? new GoogleClient();

  const authService = new AuthService({ tokenService, userRepo, oauthAccountRepo });
  const voiceService = new VoiceService({ openai, glossaryRepo, dailyUsageRepo });
  const notificationService = overrides?.notificationService ?? new NotificationService(deviceTokenRepo, null);

  const app = await buildApp({
    config,
    authService,
    tokenService,
    voiceService,
    deviceTokenRepo,
    notificationService,
    stateStore,
    githubClient: githubClient as GithubClient,
    googleClient: googleClient as GoogleClient,
  });
  await app.ready();

  async function createUser(opts: { provider?: string; providerUserId?: string } = {}): Promise<TestUser> {
    const provider = opts.provider ?? "github";
    const providerUserId = opts.providerUserId ?? new ObjectId().toHexString();
    const userId = new ObjectId();
    const now = new Date();

    await dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users).insertOne({
      _id: userId,
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    await dbAccessor.getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts).insertOne({
      _id: new ObjectId(),
      userId,
      provider,
      providerUserId,
      providerUsername: `testuser_${userId.toHexString()}`,
      createdAt: now,
      updatedAt: now,
    });

    const userIdStr = userId.toHexString();
    const accessToken = tokenService.signAccessToken({
      userId: userIdStr,
      provider,
      providerUserId,
    });
    const refreshToken = tokenService.signRefreshToken({
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

  function createExpiredAccessToken(opts: { userId: string; provider: string; providerUserId: string }): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      {
        tokenType: "access",
        userId: opts.userId,
        provider: opts.provider,
        providerUserId: opts.providerUserId,
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
    await dbAccessor.getDb(MongoDbDatabase.Auth).dropDatabase();
    await dbConnector.close();
  }

  return { app, dbAccessor, tokenService, cleanup, createUser, createExpiredRefreshToken, createExpiredAccessToken };
}

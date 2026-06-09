import * as crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { GithubClient } from "../../src/clients/auth/github-client.js";
import { GoogleClient } from "../../src/clients/auth/google-client.js";
import type { OAuthClient } from "../../src/clients/auth/oauth-client.js";
import { AppleClient } from "../../src/clients/auth/apple-client.js";
import { AppleNativeVerifier } from "../../src/services/apple-native-verifier.js";
import { OpenAIClient } from "../../src/clients/openai-client.js";
import type { User, OAuthAccount } from "../../src/models/documents.js";
import { MongoDbAccessor } from "../../src/db/mongo-db-accessor.js";
import { MongoDbConnector } from "../../src/db/mongo-db-connector.js";
import { MongoDbDatabase, AuthDbCollection } from "../../src/types/mongo.js";
import { StateStore } from "../../src/lib/state-store.js";
import { BridgeRepository } from "../../src/repositories/bridge-repo.js";
import { DailyUsageRepository } from "../../src/repositories/daily-usage-repo.js";
import { DeviceTokenRepository } from "../../src/repositories/device-token-repo.js";
import { GlossaryEntryRepository } from "../../src/repositories/glossary-entry-repo.js";
import { OAuthAccountRepository } from "../../src/repositories/oauth-account-repo.js";
import { PasswordAccountRepository } from "../../src/repositories/password-account-repo.js";
import { UserRepository } from "../../src/repositories/user-repo.js";
import { buildApp } from "../../src/server.js";
import { AuthService } from "../../src/services/auth-service.js";
import { BridgeService } from "../../src/services/bridge-service.js";
import { BridgeStateTracker } from "../../src/services/bridge-state-tracker.js";
import { NotificationService } from "../../src/services/notification-service.js";
import { PendingAuthStore } from "../../src/services/pending-auth-store.js";
import { SessionMetadataService } from "../../src/services/session-metadata-service.js";
import { InstallScriptService } from "../../src/services/install-script-service.js";
import { LegalDocumentService } from "../../src/services/legal-document-service.js";
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
  pendingAuthStore: PendingAuthStore;
  cleanup: () => Promise<void>;
  createUser: (opts?: { provider?: string; providerUserId?: string }) => Promise<TestUser>;
  createExpiredRefreshToken: (userId: string) => string;
  createExpiredAccessToken: (opts: {
    userId: string;
    provider: string;
    providerUserId: string;
    tokenVersion?: number;
  }) => string;
};

export type TestAppOverrides = {
  githubClient?: OAuthClient;
  googleClient?: OAuthClient;
  appleClient?: OAuthClient;
  appleNativeVerifier?: AppleNativeVerifier;
  notificationService?: NotificationService;
  bridgeStateTracker?: BridgeStateTracker;
  bridgeService?: BridgeService;
  sessionMetadataService?: SessionMetadataService;
  installScriptService?: InstallScriptService;
  legalDocumentService?: LegalDocumentService;
};

export type { OAuthClient };

export async function createTestApp(overrides?: TestAppOverrides): Promise<TestContext> {
  const { privateKey: privPem, publicKey: pubPem } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Prefer an externally-provided MongoDB (faster local-dev cycle, CI cache
  // hits, no first-run binary download). Fall back to mongodb-memory-server
  // for hermetic CI runs and contributor convenience.
  let mongoServer: MongoMemoryServer | null = null;
  let mongoUri: string;
  if (process.env.MONGODB_URI_TEST) {
    mongoUri = process.env.MONGODB_URI_TEST;
  } else {
    mongoServer = await MongoMemoryServer.create();
    mongoUri = mongoServer.getUri();
  }
  process.env.AUTH_BASE_URL ??= "https://api.sesori.com";
  process.env.MONGODB_URI = mongoUri;
  process.env.JWT_PRIVATE_KEY = privPem;
  process.env.JWT_PUBLIC_KEY = pubPem;
  process.env.GITHUB_CLIENT_ID ??= "test-github-client-id";
  process.env.GITHUB_CLIENT_SECRET ??= "test-github-client-secret";
  process.env.GOOGLE_CLIENT_ID ??= "test-google-client-id";
  process.env.GOOGLE_CLIENT_SECRET ??= "test-google-client-secret";
  process.env.APPLE_CLIENT_ID ??= "test-apple-client-id";
  process.env.APPLE_IOS_CLIENT_ID ??= "test.ios.bundle";
  process.env.APPLE_TEAM_ID ??= "TESTTEAM";
  process.env.APPLE_KEY_ID ??= "TESTKEY";
  process.env.APPLE_PRIVATE_KEY ??= "-----BEGIN PRIVATE KEY-----\ntestkey\n-----END PRIVATE KEY-----\n";
  process.env.ALLOWED_REDIRECT_URIS ??= "myapp://oauth/callback,https://app.example.com/oauth/callback";
  process.env.RELAY_URL ??= "ws://localhost:8080";
  process.env.RELAY_WEBHOOK_SECRET ??= "test-relay-secret";
  process.env.OPENAI_API_KEY ??= "test-openai-api-key";
  process.env.OPENAI_TRANSCRIPTION_MODEL ??= "gpt-4o-mini-transcribe";
  process.env.FCM_SA_JSON ??= Buffer.from(
    JSON.stringify({
      type: "service_account",
      project_id: "test-project",
      private_key_id: "test-key-id",
      private_key: "-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----\n",
      client_email: "test@test-project.iam.gserviceaccount.com",
      client_id: "123456789",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url:
        "https://www.googleapis.com/robot/v1/metadata/x509/test%40test-project.iam.gserviceaccount.com",
      universe_domain: "googleapis.com",
    }),
  ).toString("base64");

  const config = loadConfig();

  const dbConnector = new MongoDbConnector({ connectionString: mongoUri });
  const dbAccessor = new MongoDbAccessor(dbConnector);

  await dbAccessor.getDb(MongoDbDatabase.Auth).dropDatabase();
  await dbAccessor.ensureIndexes();

  const userRepo = new UserRepository(dbAccessor);
  const oauthAccountRepo = new OAuthAccountRepository(dbAccessor);
  const passwordAccountRepo = new PasswordAccountRepository(dbAccessor);
  const glossaryRepo = new GlossaryEntryRepository(dbAccessor);
  const dailyUsageRepo = new DailyUsageRepository(dbAccessor);
  const deviceTokenRepo = new DeviceTokenRepository(dbAccessor);
  const bridgeRepo = new BridgeRepository(dbAccessor);

  const tokenService = new TokenService(privPem, pubPem);
  const stateStore = new StateStore();
  const pendingAuthStore = new PendingAuthStore();

  const openai = new OpenAIClient({ apiKey: "test-key", model: "gpt-4o-mini-transcribe" });
  const githubClient = overrides?.githubClient ?? new GithubClient();
  const googleClient = overrides?.googleClient ?? new GoogleClient();
  const appleClient =
    overrides?.appleClient ??
    new AppleClient({
      teamId: config.APPLE_TEAM_ID,
      keyId: config.APPLE_KEY_ID,
      privateKey: config.APPLE_PRIVATE_KEY,
    });
  const appleNativeVerifier =
    overrides?.appleNativeVerifier ??
    new AppleNativeVerifier({
      clientId: config.APPLE_CLIENT_ID,
      iosClientId: config.APPLE_IOS_CLIENT_ID,
    });

  const notificationService = overrides?.notificationService ?? new NotificationService(deviceTokenRepo, null);
  const bridgeStateTracker = overrides?.bridgeStateTracker ?? new BridgeStateTracker(notificationService);
  const bridgeService = overrides?.bridgeService ?? new BridgeService({ bridgeRepo, bridgeStateTracker });
  const authService = new AuthService({ tokenService, userRepo, oauthAccountRepo, passwordAccountRepo, bridgeService });
  const voiceService = new VoiceService({ openai, glossaryRepo, dailyUsageRepo });
  const sessionMetadataService =
    overrides?.sessionMetadataService ?? new SessionMetadataService({ openai, dailyUsageRepo, model: "gpt-4o-mini" });
  const installScriptService = overrides?.installScriptService ?? new InstallScriptService();
  const legalDocumentService =
    overrides?.legalDocumentService ?? new LegalDocumentService("# Test Terms\n", "# Test Privacy\n");

  const app = await buildApp({
    config,
    authService,
    bridgeService,
    tokenService,
    voiceService,
    sessionMetadataService,
    installScriptService,
    legalDocumentService,
    deviceTokenRepo,
    notificationService,
    bridgeStateTracker,
    stateStore,
    githubClient,
    googleClient,
    appleClient,
    appleNativeVerifier,
    pendingAuthStore,
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
      tokenVersion: 0,
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

  function createExpiredAccessToken(opts: {
    userId: string;
    provider: string;
    providerUserId: string;
    tokenVersion?: number;
  }): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      {
        tokenType: "access",
        userId: opts.userId,
        provider: opts.provider,
        providerUserId: opts.providerUserId,
        tokenVersion: opts.tokenVersion ?? 0,
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
    bridgeStateTracker.dispose();
    await app.close();
    await dbAccessor.getDb(MongoDbDatabase.Auth).dropDatabase();
    await dbConnector.close();
    if (mongoServer) {
      await mongoServer.stop();
    }
  }

  return {
    app,
    dbAccessor,
    tokenService,
    pendingAuthStore,
    cleanup,
    createUser,
    createExpiredRefreshToken,
    createExpiredAccessToken,
  };
}

import * as admin from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { GithubClient } from "./clients/auth/github-client.js";
import { GoogleClient } from "./clients/auth/google-client.js";
import { OpenAIClient } from "./clients/openai-client.js";
import { loadConfig } from "./config.js";
import { MongoDbAccessor } from "./db/mongo-db-accessor.js";
import { MongoDbConnector } from "./db/mongo-db-connector.js";
import stateStore from "./lib/state-store.js";
import { DailyUsageRepository } from "./repositories/daily-usage-repo.js";
import { DeviceTokenRepository } from "./repositories/device-token-repo.js";
import { GlossaryEntryRepository } from "./repositories/glossary-entry-repo.js";
import { OAuthAccountRepository } from "./repositories/oauth-account-repo.js";
import { UserRepository } from "./repositories/user-repo.js";
import { buildApp } from "./server.js";
import { AuthService } from "./services/auth-service.js";
import { NotificationService } from "./services/notification-service.js";
import { TokenService } from "./services/token-service.js";
import { VoiceService } from "./services/voice-service.js";

async function main() {
  const config = loadConfig();

  const dbConnector = new MongoDbConnector({
    connectionString: config.MONGODB_URI,
    clientOptions: {
      connectTimeoutMS: 10_000,
      timeoutMS: 10_000,
      maxPoolSize: 50,
      minPoolSize: 5,
      maxIdleTimeMS: 60_000,
    },
    onError: (error) => console.error("MongoDB error:", error),
    onOpen: () => console.log("MongoDB connected"),
    onClose: () => console.log("MongoDB connection closed"),
  });

  const dbAccessor = new MongoDbAccessor(dbConnector);

  console.log("Creating indexes...");
  await dbAccessor.ensureIndexes();
  console.log("Indexes ready");

  const userRepo = new UserRepository(dbAccessor);
  const oauthAccountRepo = new OAuthAccountRepository(dbAccessor);
  const glossaryRepo = new GlossaryEntryRepository(dbAccessor);
  const dailyUsageRepo = new DailyUsageRepository(dbAccessor);
  const deviceTokenRepo = new DeviceTokenRepository(dbAccessor);

  const tokenService = new TokenService(config.JWT_PRIVATE_KEY, config.JWT_PUBLIC_KEY);
  console.log("JWT keys loaded");

  let messaging: ReturnType<typeof getMessaging> | null = null;
  try {
    admin.initializeApp();
    messaging = getMessaging();
    console.log("Firebase Admin SDK initialized");
  } catch (error) {
    console.warn(
      "Firebase Admin SDK initialization failed (push notifications disabled):",
      error instanceof Error ? error.message : String(error),
    );
  }

  const notificationService = new NotificationService(deviceTokenRepo, messaging);

  const openai = new OpenAIClient({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_TRANSCRIPTION_MODEL });
  console.log(`OpenAI client initialized (model: ${config.OPENAI_TRANSCRIPTION_MODEL})`);

  const githubClient = new GithubClient();
  const googleClient = new GoogleClient();

  const authService = new AuthService({
    tokenService,
    userRepo,
    oauthAccountRepo,
    deviceTokenRepo,
  });
  const voiceService = new VoiceService({ openai, glossaryRepo, dailyUsageRepo });

  const app = await buildApp({
    config,
    authService,
    tokenService,
    voiceService,
    deviceTokenRepo,
    notificationService,
    stateStore,
    githubClient,
    googleClient,
  });

  const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`Server listening at ${address}`);

  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`Received ${signal}, shutting down gracefully...`);
      await app.close();
      await dbConnector.close();
      process.exit(0);
    });
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

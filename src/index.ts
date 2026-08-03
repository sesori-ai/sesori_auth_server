import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as admin from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { AppleClient } from "./clients/auth/apple-client.js";
import { GithubClient } from "./clients/auth/github-client.js";
import { GoogleClient } from "./clients/auth/google-client.js";
import { OpenAIClient } from "./clients/openai-client.js";
import { loadConfig } from "./config.js";
import { MongoDbAccessor } from "./db/mongo-db-accessor.js";
import { MongoDbConnector } from "./db/mongo-db-connector.js";
import { getLegalDocumentUrl } from "./lib/legal-document-paths.js";
import { safeErrorType } from "./lib/errors.js";
import stateStore from "./lib/state-store.js";
import { InstallScriptService } from "./services/install-script-service.js";
import { BridgeRepository } from "./repositories/bridge-repo.js";
import { DailyUsageRepository } from "./repositories/daily-usage-repo.js";
import { DeviceTokenRepository } from "./repositories/device-token-repo.js";
import { GlossaryEntryRepository } from "./repositories/glossary-entry-repo.js";
import { OAuthAccountRepository } from "./repositories/oauth-account-repo.js";
import { PasswordAccountRepository } from "./repositories/password-account-repo.js";
import { UserRepository } from "./repositories/user-repo.js";
import { ActivationStateRepository } from "./repositories/activation-state-repo.js";
import { buildApp } from "./server.js";
import { AuthService } from "./services/auth-service.js";
import { ActivationReminderService } from "./services/activation-reminder-service.js";
import { ActivationService } from "./services/activation-service.js";
import { AppleNativeVerifier } from "./services/apple-native-verifier.js";
import { BridgeService } from "./services/bridge-service.js";
import { BridgeStateTracker } from "./services/bridge-state-tracker.js";
import { LegalDocumentService } from "./services/legal-document-service.js";
import { NotificationService } from "./services/notification-service.js";
import { PendingAuthStore } from "./services/pending-auth-store.js";
import { SessionMetadataService } from "./services/session-metadata-service.js";
import { TokenService } from "./services/token-service.js";
import { VoiceService } from "./services/voice-service.js";
import { AppClientPresenceService } from "./services/app-client-presence-service.js";
import { ProductAnalyticsPreferenceService } from "./services/product-analytics-preference-service.js";
import {
  cleanupPartialStartup,
  createShutdownCoordinator,
  type ShutdownCoordinator,
  type ShutdownExitCode,
  type ShutdownSignal,
} from "./shutdown.js";
import type { FastifyInstance } from "fastify";

export type ProductionRuntime = {
  app: FastifyInstance;
  activationReminderService: ActivationReminderService;
  bridgeStateTracker: BridgeStateTracker;
  dbConnector: MongoDbConnector;
};

type StartupOwnership = Partial<ProductionRuntime>;

export type SignalTarget = {
  on: (signal: ShutdownSignal, listener: () => void) => unknown;
  off: (signal: ShutdownSignal, listener: () => void) => unknown;
};

export type MainOptions = {
  startRuntime?: () => Promise<ProductionRuntime>;
  signalTarget?: SignalTarget;
  selectExit?: (code: ShutdownExitCode) => void;
};

export type MainHandle = {
  shutdownCoordinator: ShutdownCoordinator;
  removeSignalHandlers: () => void;
};

class ProductionStartupError extends Error {
  constructor() {
    super("ProductionStartupError");
    this.name = "ProductionStartupError";
  }
}

async function composeProductionRuntime(ownership: StartupOwnership): Promise<ProductionRuntime> {
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
  ownership.dbConnector = dbConnector;

  const dbAccessor = new MongoDbAccessor(dbConnector);

  console.log("Creating indexes...");
  await dbAccessor.ensureIndexes();
  console.log("Indexes ready");

  const userRepo = new UserRepository(dbAccessor);
  await userRepo.assertProductAnalyticsPreferenceBackfillComplete();
  const oauthAccountRepo = new OAuthAccountRepository(dbAccessor);
  const passwordAccountRepo = new PasswordAccountRepository(dbAccessor);
  const glossaryRepo = new GlossaryEntryRepository(dbAccessor);
  const dailyUsageRepo = new DailyUsageRepository(dbAccessor);
  const deviceTokenRepo = new DeviceTokenRepository(dbAccessor);
  const bridgeRepo = new BridgeRepository(dbAccessor);
  const activationStateRepo = new ActivationStateRepository(dbAccessor);

  const tokenService = new TokenService(config.JWT_PRIVATE_KEY, config.JWT_PUBLIC_KEY);
  const pendingAuthStore = new PendingAuthStore({
    maxSessions: config.PENDING_AUTH_MAX_SESSIONS,
  });
  console.log("JWT keys loaded");

  let messaging: ReturnType<typeof getMessaging> | null = null;
  try {
    const fcmObject = config.FCM_SA_JSON;
    admin.initializeApp({
      credential: admin.cert({
        clientEmail: fcmObject.client_email,
        privateKey: fcmObject.private_key,
        projectId: fcmObject.project_id,
      }),
    });
    messaging = getMessaging();
    console.log("Firebase Admin SDK initialized");
  } catch (error) {
    console.warn(
      "Firebase Admin SDK initialization failed (push notifications disabled):",
      error instanceof Error ? error.message : String(error),
    );
  }

  const notificationService = new NotificationService(deviceTokenRepo, messaging);
  const bridgeStateTracker = new BridgeStateTracker(notificationService);
  ownership.bridgeStateTracker = bridgeStateTracker;
  const bridgeService = new BridgeService({ bridgeRepo, bridgeStateTracker });
  const activationService = new ActivationService({
    activationStateRepo,
    bridgeRepo,
    dailyUsageRepo,
    deviceTokenRepo,
  });
  const appClientPresenceService = new AppClientPresenceService({ deviceTokenRepo });
  const productAnalyticsPreferenceService = new ProductAnalyticsPreferenceService({
    userRepo,
    pseudonymizationKey: config.PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY,
  });
  const activationReminderService = new ActivationReminderService({
    activationStateRepo,
    notificationService,
    options: {
      enabled: config.ACTIVATION_REMINDERS_ENABLED,
      sweepIntervalMs: config.ACTIVATION_SWEEP_INTERVAL_MS,
      bridgeReminder1DelayMs: config.ACTIVATION_BRIDGE_REMINDER_1_DELAY_MS,
      bridgeReminder2DelayMs: config.ACTIVATION_BRIDGE_REMINDER_2_DELAY_MS,
      sessionReminderDelayMs: config.ACTIVATION_SESSION_REMINDER_DELAY_MS,
      batchLimit: config.ACTIVATION_SWEEP_BATCH_LIMIT,
    },
  });
  ownership.activationReminderService = activationReminderService;

  const openai = new OpenAIClient({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_TRANSCRIPTION_MODEL });
  console.log(`OpenAI client initialized (model: ${config.OPENAI_TRANSCRIPTION_MODEL})`);

  const githubClient = new GithubClient();
  const googleClient = new GoogleClient();
  const appleClient = new AppleClient({
    teamId: config.APPLE_TEAM_ID,
    keyId: config.APPLE_KEY_ID,
    privateKey: config.APPLE_PRIVATE_KEY,
  });
  const appleNativeVerifier = new AppleNativeVerifier({
    clientId: config.APPLE_CLIENT_ID,
    iosClientId: config.APPLE_IOS_CLIENT_ID,
  });

  const authService = new AuthService({
    tokenService,
    userRepo,
    oauthAccountRepo,
    passwordAccountRepo,
    deviceTokenRepo,
    bridgeService,
  });
  const voiceService = new VoiceService({ openai, glossaryRepo, dailyUsageRepo });

  const sessionMetadataService = new SessionMetadataService({
    openai,
    dailyUsageRepo,
    model: config.OPENAI_METADATA_MODEL,
  });
  const installScriptService = new InstallScriptService();
  const [termsText, privacyText] = await Promise.all([
    readFile(getLegalDocumentUrl(import.meta.url, "terms"), "utf8"),
    readFile(getLegalDocumentUrl(import.meta.url, "privacy"), "utf8"),
  ]);
  const legalDocumentService = new LegalDocumentService(termsText, privacyText);

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
    appClientPresenceService,
    notificationService,
    activationService,
    stateStore,
    githubClient,
    googleClient,
    appleClient,
    appleNativeVerifier,
    pendingAuthStore,
    productAnalyticsPreferenceService,
  });
  ownership.app = app;

  const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`Server listening at ${address}`);
  return { app, activationReminderService, bridgeStateTracker, dbConnector };
}

async function startProductionRuntime(): Promise<ProductionRuntime> {
  const ownership: StartupOwnership = {};
  try {
    return await composeProductionRuntime(ownership);
  } catch {
    await cleanupPartialStartup(ownership);
    throw new ProductionStartupError();
  }
}

export async function main(options: MainOptions = {}): Promise<MainHandle> {
  const runtime = await (options.startRuntime ?? startProductionRuntime)();
  const signalTarget = options.signalTarget ?? process;
  const shutdownCoordinator = createShutdownCoordinator({
    app: {
      close: runtime.app.close.bind(runtime.app),
      closeAllConnections: () => runtime.app.server.closeAllConnections(),
    },
    activationReminderService: runtime.activationReminderService,
    bridgeStateTracker: runtime.bridgeStateTracker,
    dbConnector: runtime.dbConnector,
    selectExit: options.selectExit ?? ((code) => process.exit(code)),
  });

  const onSignal = (signal: ShutdownSignal): void => {
    void shutdownCoordinator.shutdown(signal);
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");
  signalTarget.on("SIGINT", onSigint);
  signalTarget.on("SIGTERM", onSigterm);

  let removed = false;
  const removeSignalHandlers = (): void => {
    if (removed) {
      return;
    }

    removed = true;
    signalTarget.off("SIGINT", onSigint);
    signalTarget.off("SIGTERM", onSigterm);
  };

  runtime.activationReminderService.start();
  return { shutdownCoordinator, removeSignalHandlers };
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error) => {
    console.error("[Startup] Fatal error", { errorType: safeErrorType({ error }) });
    process.exit(1);
  });
}

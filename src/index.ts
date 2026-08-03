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
import { SettingsConfigurationRepository } from "./repositories/settings-configuration-repo.js";
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
import { SettingsService } from "./services/settings-service.js";
import {
  SHUTDOWN_DRAIN_DEADLINE_MS,
  SHUTDOWN_HARD_DEADLINE_MS,
  cleanupPartialStartup,
  createExitSelector,
  createShutdownCoordinator,
  defaultShutdownTimers,
  forceFencePartialStartup,
  remainingShutdownMs,
  type PartialStartupResources,
  type ShutdownCoordinator,
  type ShutdownExitCode,
  type ShutdownRequestWaiters,
  type ShutdownSignal,
  type ShutdownTimers,
} from "./shutdown.js";
import type { FastifyInstance } from "fastify";

export type ProductionRuntime = {
  app: FastifyInstance;
  activationReminderService: ActivationReminderService;
  bridgeStateTracker: BridgeStateTracker;
  dbConnector: MongoDbConnector;
  requestWaiters: ShutdownRequestWaiters[];
};

type StartupOwnership = Partial<ProductionRuntime>;

type StartupContext = {
  ownership: StartupOwnership;
  throwIfShutdownRequested: () => void;
};

export type SignalTarget = {
  on: (signal: ShutdownSignal, listener: () => void) => unknown;
  off: (signal: ShutdownSignal, listener: () => void) => unknown;
};

export type MainOptions = {
  startRuntime?: (startup: StartupContext) => Promise<ProductionRuntime>;
  signalTarget?: SignalTarget;
  selectExit?: (code: ShutdownExitCode) => void;
  now?: () => number;
  timers?: ShutdownTimers;
};

export type MainHandle = {
  shutdownCoordinator: ShutdownCoordinator;
  removeSignalHandlers: () => void;
};

class ProductionStartupError extends Error {
  constructor(options?: ErrorOptions) {
    super("ProductionStartupError", options);
    this.name = "ProductionStartupError";
  }
}

const PRODUCTION_STARTUP_INTERRUPTED = Symbol("ProductionStartupInterrupted");

async function composeProductionRuntime(
  ownership: StartupOwnership,
  throwIfShutdownRequested: () => void,
): Promise<ProductionRuntime> {
  throwIfShutdownRequested();
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
  throwIfShutdownRequested();
  console.log("Indexes ready");

  const userRepo = new UserRepository(dbAccessor);
  await userRepo.assertProductAnalyticsPreferenceBackfillComplete();
  throwIfShutdownRequested();
  const oauthAccountRepo = new OAuthAccountRepository(dbAccessor);
  const passwordAccountRepo = new PasswordAccountRepository(dbAccessor);
  const glossaryRepo = new GlossaryEntryRepository(dbAccessor);
  const dailyUsageRepo = new DailyUsageRepository(dbAccessor);
  const deviceTokenRepo = new DeviceTokenRepository(dbAccessor);
  const bridgeRepo = new BridgeRepository(dbAccessor);
  const activationStateRepo = new ActivationStateRepository(dbAccessor);
  const settingsRepo = new SettingsConfigurationRepository(dbAccessor);

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
  ownership.requestWaiters = [pendingAuthStore, appClientPresenceService];
  const productAnalyticsPreferenceService = new ProductAnalyticsPreferenceService({
    userRepo,
    pseudonymizationKey: config.PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY,
  });
  const settingsService = new SettingsService({ settingsRepo });
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
  throwIfShutdownRequested();
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
    settingsService,
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
  throwIfShutdownRequested();

  const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
  throwIfShutdownRequested();
  console.log(`Server listening at ${address}`);
  return {
    app,
    activationReminderService,
    bridgeStateTracker,
    dbConnector,
    requestWaiters: [pendingAuthStore, appClientPresenceService],
  };
}

function startProductionRuntime(startup: StartupContext): Promise<ProductionRuntime> {
  return composeProductionRuntime(startup.ownership, startup.throwIfShutdownRequested);
}

function partialStartupResources(ownership: StartupOwnership): PartialStartupResources {
  const app = ownership.app;
  return {
    app: app
      ? {
          close: app.close.bind(app),
          closeAllConnections: () => app.server.closeAllConnections(),
        }
      : undefined,
    requestWaiters: ownership.requestWaiters,
    activationReminderService: ownership.activationReminderService,
    bridgeStateTracker: ownership.bridgeStateTracker,
    dbConnector: ownership.dbConnector,
  };
}

type StartupResult = { runtime: ProductionRuntime; error?: never } | { runtime?: never; error: unknown };

export async function main(options: MainOptions = {}): Promise<MainHandle> {
  const signalTarget = options.signalTarget ?? process;
  const timers = options.timers ?? defaultShutdownTimers;
  const now = options.now ?? Date.now;
  const ownership: StartupOwnership = {};
  const selectExit = createExitSelector(options.selectExit ?? ((code: ShutdownExitCode) => process.exit(code)));
  let shutdownCoordinator: ShutdownCoordinator | null = null;
  let startupShutdownPromise: Promise<ShutdownExitCode> | null = null;
  let startupHardFenced = false;
  let startupResult: Promise<StartupResult> = new Promise(() => undefined);
  let resolveSignalRequest!: () => void;
  const signalRequest = new Promise<void>((resolve) => {
    resolveSignalRequest = resolve;
  });

  const forceCurrentOwnership = (): void => {
    forceFencePartialStartup(partialStartupResources(ownership));
  };

  const createRuntimeCoordinator = (runtime: ProductionRuntime, startedAt?: number): ShutdownCoordinator =>
    createShutdownCoordinator({
      app: {
        close: runtime.app.close.bind(runtime.app),
        closeAllConnections: () => runtime.app.server.closeAllConnections(),
        closeIdleConnections: () => runtime.app.server.closeIdleConnections(),
      },
      requestWaiters: runtime.requestWaiters,
      activationReminderService: runtime.activationReminderService,
      bridgeStateTracker: runtime.bridgeStateTracker,
      dbConnector: runtime.dbConnector,
      selectExit,
      startedAt,
      now,
      timers,
    });

  const shutdownPendingStartup = async (signal: ShutdownSignal, startedAt: number): Promise<ShutdownExitCode> => {
    console.log("[Shutdown] Started", { signal });
    const drainTimer = timers.setTimeout(
      forceCurrentOwnership,
      remainingShutdownMs(startedAt, SHUTDOWN_DRAIN_DEADLINE_MS, now),
    );
    drainTimer.unref?.();

    let hardTimer!: ReturnType<ShutdownTimers["setTimeout"]>;
    const hardDeadline = new Promise<ShutdownExitCode>((resolve) => {
      hardTimer = timers.setTimeout(
        () => {
          startupHardFenced = true;
          forceCurrentOwnership();
          resolve(selectExit(1));
        },
        remainingShutdownMs(startedAt, SHUTDOWN_HARD_DEADLINE_MS, now),
      );
    });
    const result = await Promise.race([startupResult, hardDeadline.then((exitCode) => ({ exitCode }))]);

    timers.clearTimeout(drainTimer);
    if ("exitCode" in result) {
      return result.exitCode;
    }

    timers.clearTimeout(hardTimer);
    if (result.runtime) {
      shutdownCoordinator = createRuntimeCoordinator(result.runtime, startedAt);
      return shutdownCoordinator.shutdown(signal);
    }

    const cleanupCode = await cleanupPartialStartup(partialStartupResources(ownership), {
      startedAt,
      now,
      timers,
    });
    if (result.error === PRODUCTION_STARTUP_INTERRUPTED) {
      return selectExit(cleanupCode);
    }

    console.error("[Startup] Failed during shutdown", {
      errorType: safeErrorType({ error: result.error }),
    });
    return selectExit(1);
  };

  const onSignal = (signal: ShutdownSignal): void => {
    if (shutdownCoordinator) {
      void shutdownCoordinator.shutdown(signal);
      return;
    }

    if (!startupShutdownPromise) {
      const startedAt = now();
      startupShutdownPromise = Promise.resolve().then(() => shutdownPendingStartup(signal, startedAt));
      resolveSignalRequest();
    }
  };
  const signalHandlers: Array<[ShutdownSignal, () => void]> = [
    ["SIGINT", () => onSignal("SIGINT")],
    ["SIGTERM", () => onSignal("SIGTERM")],
  ];
  const removeSignalHandlers = (): void => {
    for (const [signal, listener] of signalHandlers.splice(0)) {
      try {
        signalTarget.off(signal, listener);
      } catch (error) {
        console.error("[Startup] Signal handler removal failed", { signal, errorType: safeErrorType({ error }) });
      }
    }
  };
  const failStartup = async (error: unknown): Promise<never> => {
    removeSignalHandlers();
    await cleanupPartialStartup(partialStartupResources(ownership), { now, timers });
    throw new ProductionStartupError({ cause: error });
  };

  try {
    for (const [signal, listener] of signalHandlers) {
      signalTarget.on(signal, listener);
    }
  } catch (error) {
    return failStartup(error);
  }

  const throwIfShutdownRequested = (): void => {
    if (startupShutdownPromise) {
      throw PRODUCTION_STARTUP_INTERRUPTED;
    }
  };
  let starting: Promise<ProductionRuntime>;
  try {
    starting = (options.startRuntime ?? startProductionRuntime)({
      ownership,
      throwIfShutdownRequested,
    });
  } catch (error) {
    starting = Promise.reject(error);
  }
  startupResult = starting
    .then<StartupResult, StartupResult>(
      (runtime) => ({ runtime }),
      (error: unknown) => ({ error }),
    )
    .then((result) => {
      if (result.runtime) {
        const { runtime } = result;
        Object.assign(ownership, runtime);
      }
      if (startupHardFenced) {
        forceCurrentOwnership();
      }
      return result;
    });

  await Promise.race([startupResult.then(() => undefined), signalRequest]);
  const completedStartupShutdown = startupShutdownPromise;
  if (completedStartupShutdown) {
    await completedStartupShutdown;
    return {
      shutdownCoordinator: shutdownCoordinator ?? { shutdown: () => completedStartupShutdown },
      removeSignalHandlers,
    };
  }

  const result = await startupResult;
  if (!result.runtime) {
    return failStartup(result.error);
  }

  shutdownCoordinator = createRuntimeCoordinator(result.runtime);
  try {
    result.runtime.activationReminderService.start();
  } catch (error) {
    return failStartup(error);
  }

  return { shutdownCoordinator, removeSignalHandlers };
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error) => {
    const cause = error instanceof Error ? error.cause : undefined;
    console.error("[Startup] Fatal error", {
      errorType: safeErrorType({ error }),
      causeType: safeErrorType({ error: cause }),
    });
    process.exit(1);
  });
}

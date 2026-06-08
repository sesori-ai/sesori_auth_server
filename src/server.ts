import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { AppleClient } from "./clients/auth/apple-client.js";
import type { GithubClient } from "./clients/auth/github-client.js";
import type { GoogleClient } from "./clients/auth/google-client.js";
import type { Config } from "./config.js";
import { ApiError } from "./lib/errors.js";
import type { StateStore } from "./lib/state-store.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createRelayAuthMiddleware } from "./middleware/relay-auth.js";
import type { HealthReply } from "./models/api.js";
import type { DeviceTokenRepository } from "./repositories/device-token-repo.js";
import type { AuthService } from "./services/auth-service.js";
import type { BridgeService } from "./services/bridge-service.js";
import type { BridgeStateTracker } from "./services/bridge-state-tracker.js";
import type { NotificationService } from "./services/notification-service.js";
import type { TokenService } from "./services/token-service.js";
import type { VoiceService } from "./services/voice-service.js";
import type { SessionMetadataService } from "./services/session-metadata-service.js";
import type { InstallScriptService } from "./services/install-script-service.js";
import type { LegalDocumentService } from "./services/legal-document-service.js";
import type { AppleNativeVerifier } from "./services/apple-native-verifier.js";
import type { PendingAuthStore } from "./services/pending-auth-store.js";
import { installRoutes } from "./routes/install.js";
import { legalRoutes } from "./routes/legal.js";
import { tokenRoutes } from "./routes/token.js";
import { appleRoutes } from "./routes/auth/apple.js";
import { appleNativeRoutes } from "./routes/auth/apple-native.js";
import { passwordRoutes } from "./routes/auth/email.js";
import { githubRoutes } from "./routes/auth/github.js";
import { googleRoutes } from "./routes/auth/google.js";
import { voiceRoutes } from "./routes/voice.js";
import { notificationRoutes } from "./routes/notifications.js";
import { bridgeRoutes } from "./routes/bridges.js";
import { sessionRoutes } from "./routes/sessions.js";
import { sessionStatusRoutes } from "./routes/auth/session-status.js";

export type AppServices = {
  config: Config;
  authService: AuthService;
  bridgeService: BridgeService;
  tokenService: TokenService;
  voiceService: VoiceService;
  sessionMetadataService: SessionMetadataService;
  installScriptService: InstallScriptService;
  legalDocumentService: LegalDocumentService;
  deviceTokenRepo: DeviceTokenRepository;
  notificationService: NotificationService;
  bridgeStateTracker: BridgeStateTracker;
  stateStore: StateStore;
  githubClient: GithubClient;
  googleClient: GoogleClient;
  appleClient: AppleClient;
  appleNativeVerifier: AppleNativeVerifier;
  pendingAuthStore: PendingAuthStore;
};

export async function buildApp(services: AppServices): Promise<FastifyInstance> {
  const app = Fastify({
    disableRequestLogging: true,
  });

  await app.register(cors, {
    origin: true,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    allowList: ["127.0.0.1", "::1"],
  });

  app.decorateRequest("user", null);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      if (error.debugMessage || error.nestedError) {
        console.error(`[${error.name}] ${error.debugMessage ?? error.message}`, error.nestedError ?? "");
      }
      return reply.status(error.errorCode).send({ error: error.message, ...error.responseBody });
    }

    // Fastify framework errors (FST_ERR_CTP_INVALID_MEDIA_TYPE, FST_ERR_VALIDATION,
    // body-too-large, etc.) carry their intended HTTP status on `statusCode`.
    // Without this branch they were collapsed to 500 — masking 415/413/400.
    const fastifyErr = error as { statusCode?: number; message?: string };
    if (typeof fastifyErr.statusCode === "number" && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      return reply.status(fastifyErr.statusCode).send({ error: fastifyErr.message ?? "bad_request" });
    }

    console.error("[UnhandledError]", error);
    return reply.status(500).send({ error: "internal_server_error" });
  });

  app.get<{ Reply: HealthReply }>("/health", async () => {
    return { status: "ok" };
  });

  await app.register(installRoutes, {
    installScriptService: services.installScriptService,
  });

  await app.register(legalRoutes, {
    legalDocumentService: services.legalDocumentService,
  });

  const requireAuth = createAuthMiddleware(services.tokenService);
  const requireRelayAuth = createRelayAuthMiddleware(services.config.RELAY_WEBHOOK_SECRET);

  await app.register(tokenRoutes, {
    authService: services.authService,
    bridgeService: services.bridgeService,
    tokenService: services.tokenService,
    requireAuth,
  });
  await app.register(githubRoutes, {
    config: services.config,
    authService: services.authService,
    stateStore: services.stateStore,
    githubClient: services.githubClient,
    pendingAuthStore: services.pendingAuthStore,
  });
  await app.register(googleRoutes, {
    config: services.config,
    authService: services.authService,
    stateStore: services.stateStore,
    googleClient: services.googleClient,
    pendingAuthStore: services.pendingAuthStore,
  });
  await app.register(appleRoutes, {
    config: services.config,
    authService: services.authService,
    stateStore: services.stateStore,
    appleClient: services.appleClient,
    pendingAuthStore: services.pendingAuthStore,
  });
  await app.register(appleNativeRoutes, {
    authService: services.authService,
    appleNativeVerifier: services.appleNativeVerifier,
    config: services.config,
  });
  await app.register(passwordRoutes, {
    authService: services.authService,
  });
  await app.register(sessionStatusRoutes, {
    pendingAuthStore: services.pendingAuthStore,
    statusPollTimeoutMs: services.config.PENDING_AUTH_POLL_TIMEOUT_MS,
  });
  await app.register(voiceRoutes, {
    voiceService: services.voiceService,
    requireAuth,
  });
  await app.register(notificationRoutes, {
    config: services.config,
    deviceTokenRepo: services.deviceTokenRepo,
    notificationService: services.notificationService,
    bridgeService: services.bridgeService,
    bridgeStateTracker: services.bridgeStateTracker,
    requireAuth,
    requireRelayAuth,
  });
  await app.register(bridgeRoutes, {
    bridgeService: services.bridgeService,
    requireAuth,
  });
  await app.register(sessionRoutes, {
    sessionMetadataService: services.sessionMetadataService,
    requireAuth,
  });

  return app;
}

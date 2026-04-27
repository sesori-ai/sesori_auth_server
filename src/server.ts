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
import type { BridgeStateTracker } from "./services/bridge-state-tracker.js";
import type { NotificationService } from "./services/notification-service.js";
import type { TokenService } from "./services/token-service.js";
import type { VoiceService } from "./services/voice-service.js";
import type { SessionMetadataService } from "./services/session-metadata-service.js";
import type { InstallScriptService } from "./services/install-script-service.js";
import type { LegalDocumentService } from "./services/legal-document-service.js";
import type { AppleNativeVerifier } from "./services/apple-native-verifier.js";
import { installRoutes } from "./routes/install.js";
import { legalRoutes } from "./routes/legal.js";
import { tokenRoutes } from "./routes/token.js";
import { appleRoutes } from "./routes/apple.js";
import { appleNativeRoutes } from "./routes/apple-native.js";
import { passwordRoutes } from "./routes/password.js";
import { githubRoutes } from "./routes/github.js";
import { googleRoutes } from "./routes/google.js";
import { voiceRoutes } from "./routes/voice.js";
import { notificationRoutes } from "./routes/notifications.js";
import { sessionRoutes } from "./routes/sessions.js";

export type AppServices = {
  config: Config;
  authService: AuthService;
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
    tokenService: services.tokenService,
    requireAuth,
  });
  await app.register(githubRoutes, {
    config: services.config,
    authService: services.authService,
    stateStore: services.stateStore,
    githubClient: services.githubClient,
  });
  await app.register(googleRoutes, {
    config: services.config,
    authService: services.authService,
    stateStore: services.stateStore,
    googleClient: services.googleClient,
  });
  await app.register(appleRoutes, {
    config: services.config,
    authService: services.authService,
    stateStore: services.stateStore,
    appleClient: services.appleClient,
  });
  await app.register(appleNativeRoutes, {
    authService: services.authService,
    appleNativeVerifier: services.appleNativeVerifier,
    config: services.config,
  });
  await app.register(passwordRoutes, {
    authService: services.authService,
  });
  await app.register(voiceRoutes, {
    voiceService: services.voiceService,
    requireAuth,
  });
  await app.register(notificationRoutes, {
    deviceTokenRepo: services.deviceTokenRepo,
    notificationService: services.notificationService,
    bridgeStateTracker: services.bridgeStateTracker,
    requireAuth,
    requireRelayAuth,
  });
  await app.register(sessionRoutes, {
    sessionMetadataService: services.sessionMetadataService,
    requireAuth,
  });

  return app;
}

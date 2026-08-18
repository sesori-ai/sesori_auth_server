import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import type { OAuthClient } from "./clients/auth/oauth-client.js";
import type { Config } from "./config.js";
import { createClientIpResolver, isLoopbackSocket } from "./lib/client-ip.js";
import { ApiError, safeErrorType } from "./lib/errors.js";
import type { StateStore } from "./lib/state-store.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createRealtimeUpgradeRateLimit } from "./middleware/realtime-upgrade-rate-limit.js";
import { createRelayAuthMiddleware } from "./middleware/relay-auth.js";
import type { HealthReply } from "./models/api.js";
import type { DeviceTokenRepository } from "./repositories/device-token-repo.js";
import type { ActivationService } from "./services/activation-service.js";
import type { AuthService } from "./services/auth-service.js";
import type { BridgeService } from "./services/bridge-service.js";
import type { NotificationService } from "./services/notification-service.js";
import type { TokenService } from "./services/token-service.js";
import type { GlossaryService } from "./services/glossary-service.js";
import type { VoiceService } from "./services/voice-service.js";
import type { SessionMetadataService } from "./services/session-metadata-service.js";
import type { InstallScriptService } from "./services/install-script-service.js";
import type { LegalDocumentService } from "./services/legal-document-service.js";
import type { AppleNativeVerifier } from "./services/apple-native-verifier.js";
import type { PendingAuthStore } from "./services/pending-auth-store.js";
import type { AppClientPresenceService } from "./services/app-client-presence-service.js";
import type { ProductAnalyticsPreferenceService } from "./services/product-analytics-preference-service.js";
import type { SettingsService } from "./services/settings-service.js";
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
import { appClientRoutes } from "./routes/app-clients.js";
import { productAnalyticsRoutes } from "./routes/product-analytics.js";
import { settingsRoutes } from "./routes/settings/settings.js";
import { voiceRealtimeRoutes, type VoiceRealtimeRouteOptions } from "./routes/voice-realtime.js";
import { MAX_TRANSPORT_PAYLOAD_BYTES } from "./routes/voice-realtime-support.js";

export type AppServices = {
  config: Config;
  authService: AuthService;
  bridgeService: BridgeService;
  tokenService: TokenService;
  voiceService: VoiceService;
  glossaryService: GlossaryService;
  sessionMetadataService: SessionMetadataService;
  installScriptService: InstallScriptService;
  legalDocumentService: LegalDocumentService;
  deviceTokenRepo: DeviceTokenRepository;
  appClientPresenceService: AppClientPresenceService;
  settingsService: SettingsService;
  notificationService: NotificationService;
  activationService: ActivationService;
  stateStore: StateStore;
  githubClient: OAuthClient;
  googleClient: OAuthClient;
  appleClient: OAuthClient;
  appleNativeVerifier: AppleNativeVerifier;
  pendingAuthStore: PendingAuthStore;
  productAnalyticsPreferenceService: ProductAnalyticsPreferenceService;
  realtime?: Omit<VoiceRealtimeRouteOptions, "preAuthRateLimit" | "requireAuth">;
};

export async function buildApp(services: AppServices): Promise<FastifyInstance> {
  const resolveClientIp = createClientIpResolver({
    source: services.config.CLIENT_IP_SOURCE,
    cloudflareIngressCidrs: services.config.CLOUDFLARE_INGRESS_CIDRS,
  });

  const app = Fastify({
    disableRequestLogging: true,
  });

  await app.register(cors, {
    origin: true,
  });

  // Whether realtime is enabled is defined by whether the composition root
  // built the bundle, and nothing else. It used to be asserted at runtime
  // against the config flag as well, which meant three sources of truth kept in
  // step by a throw. `/voice/capabilities` below reports this same fact, so it
  // can no longer advertise a protocol whose route was never registered.
  const realtimeEnabled = Boolean(services.realtime);

  if (services.realtime) {
    await app.register(websocket, {
      options: { maxPayload: MAX_TRANSPORT_PAYLOAD_BYTES, perMessageDeflate: false },
    });
  }

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    allowList: (request) => isLoopbackSocket(request),
    keyGenerator: resolveClientIp,
  });

  app.decorateRequest("user", null);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      if (error.debugMessage || error.nestedError) {
        console.error(`[${error.name}] ${error.debugMessage ?? error.message}`, error.nestedError ?? "");
      }

      // Sole owner of Retry-After: emitted only from typed error metadata, so
      // routes and provider clients never write this header themselves.
      const { retryAfterSeconds } = error;
      if (typeof retryAfterSeconds === "number" && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
        reply.header("Retry-After", String(retryAfterSeconds));
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

  app.get<{ Reply: HealthReply }>("/health", { config: { rateLimit: false } }, async () => {
    return { status: "ok" };
  });

  // Exempt from the global limiter deliberately. The handler returns a
  // constant, so the exemption costs nothing, while the global limiter keys on
  // client IP: an office, campus, or carrier NAT shares one key, and 100
  // requests a minute across that whole population is reachable. Capability
  // discovery runs before every recording attempt and decides whether voice
  // works at all, so a 429 here does not degrade one caller, it silently drops
  // every client behind that address onto the legacy path. Do not remove this
  // on the reasoning that a public endpoint should not be exempt.
  app.get<{ Reply: { realtime: { enabled: boolean; protocolVersions: [1] } } }>(
    "/voice/capabilities",
    { config: { rateLimit: false } },
    async () => ({
      realtime: { enabled: realtimeEnabled, protocolVersions: [1] },
    }),
  );

  await app.register(installRoutes, {
    installScriptService: services.installScriptService,
  });

  await app.register(legalRoutes, {
    legalDocumentService: services.legalDocumentService,
  });

  const requireAuth = createAuthMiddleware(services.tokenService, {
    devBypassEnabled: services.config.AUTH_DEV_BYPASS_ENABLED,
  });
  const requireRelayAuth = createRelayAuthMiddleware(services.config.RELAY_WEBHOOK_SECRET);

  if (services.realtime) {
    let realtimeDisposePromise: Promise<void> | null = null;
    await app.register(voiceRealtimeRoutes, {
      ...services.realtime,
      preAuthRateLimit: createRealtimeUpgradeRateLimit({
        maxUpgradesPerMinute: services.config.REALTIME_UPGRADE_MAX_PER_MINUTE,
      }),
      requireAuth,
    });
    // Safety net for closes that bypass the shutdown coordinator (tests,
    // embedded use). It cannot substitute for that ordering: onClose runs
    // after @fastify/websocket's preClose has already closed every client
    // socket, so a terminal frame emitted from here is written to a dead
    // socket. `src/shutdown.ts` disposes realtime before calling app.close(),
    // which leaves this hook awaiting an already-settled disposal.
    app.addHook("onClose", async () => {
      realtimeDisposePromise ??= services.realtime?.realtimeService.dispose() ?? Promise.resolve();
      // A rejected disposal must not reject app.close(): the shutdown
      // coordinator treats a failed drain as degraded but a failed app.close()
      // as fatal, so propagating here would resurrect the exit-1-on-SIGTERM
      // behaviour this deliberately does not have.
      await realtimeDisposePromise.catch((error: unknown) => {
        console.warn("[Server] realtime disposal degraded", { errorType: safeErrorType({ error }) });
      });
    });
  }

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
  await app.register(appClientRoutes, {
    appClientPresenceService: services.appClientPresenceService,
    requireAuth,
  });
  await app.register(productAnalyticsRoutes, {
    productAnalyticsPreferenceService: services.productAnalyticsPreferenceService,
    requireAuth,
  });
  await app.register(voiceRoutes, {
    voiceService: services.voiceService,
    glossaryService: services.glossaryService,
    requireAuth,
  });
  await app.register(notificationRoutes, {
    config: services.config,
    deviceTokenRepo: services.deviceTokenRepo,
    appClientPresenceService: services.appClientPresenceService,
    notificationService: services.notificationService,
    bridgeService: services.bridgeService,
    activationService: services.activationService,
    requireAuth,
    requireRelayAuth,
  });
  await app.register(bridgeRoutes, {
    bridgeService: services.bridgeService,
    activationService: services.activationService,
    requireAuth,
  });
  await app.register(settingsRoutes, {
    settingsService: services.settingsService,
    tokenService: services.tokenService,
    resolveClientIp,
    requireAuth,
  });
  await app.register(sessionRoutes, {
    sessionMetadataService: services.sessionMetadataService,
    activationService: services.activationService,
    requireAuth,
  });

  return app;
}

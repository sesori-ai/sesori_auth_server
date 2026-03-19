import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { GithubClient } from "./clients/auth/github-client.js";
import type { GoogleClient } from "./clients/auth/google-client.js";
import type { Config } from "./config.js";
import { ApiError } from "./lib/errors.js";
import type { StateStore } from "./lib/state-store.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import type { HealthReply } from "./models/api.js";
import type { AuthService } from "./services/auth-service.js";
import type { TokenService } from "./services/token-service.js";
import type { VoiceService } from "./services/voice-service.js";
import { tokenRoutes } from "./routes/token.js";
import { githubRoutes } from "./routes/github.js";
import { googleRoutes } from "./routes/google.js";
import { voiceRoutes } from "./routes/voice.js";

export type AppServices = {
  config: Config;
  authService: AuthService;
  tokenService: TokenService;
  voiceService: VoiceService;
  stateStore: StateStore;
  githubClient: GithubClient;
  googleClient: GoogleClient;
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
      return reply.status(error.errorCode).send({ error: error.message });
    }

    console.error("[UnhandledError]", error);
    return reply.status(500).send({ error: "internal_server_error" });
  });

  app.get<{ Reply: HealthReply }>("/health", async () => {
    return { status: "ok" };
  });

  const requireAuth = createAuthMiddleware(services.tokenService);

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
  await app.register(voiceRoutes, {
    voiceService: services.voiceService,
    requireAuth,
  });

  return app;
}

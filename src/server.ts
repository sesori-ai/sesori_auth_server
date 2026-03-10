import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { tokenRoutes } from "./auth/token.js";
import { githubRoutes } from "./auth/github.js";
import { googleRoutes } from "./auth/google.js";
import { bridgeRoutes } from "./bridge/registry.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  // Register CORS
  await app.register(cors, {
    origin: true,
  });

  // Decorate request with user for auth middleware (must be before routes)
  app.decorateRequest("user", null);

  // Health check endpoint
  app.get("/health", async (request, reply) => {
    return { status: "ok" };
  });

  await app.register(tokenRoutes);
  await app.register(githubRoutes);
  await app.register(googleRoutes);
  await app.register(bridgeRoutes);

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);
    reply.status(500).send({
      error: "Internal server error",
    });
  });

  return app;
}

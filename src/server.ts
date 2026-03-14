import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { tokenRoutes } from "./routes/token.js";
import { githubRoutes } from "./routes/github.js";
import { googleRoutes } from "./routes/google.js";
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
  app.get<{ Reply: { status: "ok" } }>("/health", async () => {
    return { status: "ok" };
  });

  await app.register(tokenRoutes);
  await app.register(githubRoutes);
  await app.register(googleRoutes);

  // Global error handler
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.status(500).send({
      error: "Internal server error",
    });
  });

  return app;
}

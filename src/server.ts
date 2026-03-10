import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  // Register CORS
  await app.register(cors, {
    origin: true,
  });

  // Health check endpoint
  app.get("/health", async (request, reply) => {
    return { status: "ok" };
  });

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);
    reply.status(500).send({
      error: "Internal server error",
    });
  });

  return app;
}

import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { ApiError } from "./lib/errors.js";
import type { HealthReply } from "./models/api.js";
import { tokenRoutes } from "./routes/token.js";
import { githubRoutes } from "./routes/github.js";
import { googleRoutes } from "./routes/google.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    disableRequestLogging: true,
  });

  await app.register(cors, {
    origin: true,
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

  await app.register(tokenRoutes);
  await app.register(githubRoutes);
  await app.register(googleRoutes);

  return app;
}

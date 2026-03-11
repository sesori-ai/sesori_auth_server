import { loadConfig } from "./config.js";
import { DbClient } from "./db/client.js";
import { DatabaseAccessor } from "./db/collections.js";
import { buildApp } from "./server.js";
import { TokenService } from "./services/token-service.js";

async function main() {
  const config = loadConfig();

  console.log("Connecting to MongoDB...");
  await DbClient.connect(config.MONGODB_URI);
  console.log("MongoDB connected");

  console.log("Creating indexes...");
  await DatabaseAccessor.ensureIndexes();
  console.log("Indexes ready");

  TokenService.setKeys(config.JWT_PRIVATE_KEY, config.JWT_PUBLIC_KEY);
  console.log("JWT keys loaded");

  const app = await buildApp();

  const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`Server listening at ${address}`);

  // Graceful shutdown
  const signals = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`Received ${signal}, shutting down gracefully...`);
      await app.close();
      await DbClient.close();
      process.exit(0);
    });
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

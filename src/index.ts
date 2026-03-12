import { loadConfig } from "./config.js";
import { closeDb } from "./db/db-client.js";
import { DatabaseAccessor } from "./db/database-accessor.js";
import { buildApp } from "./server.js";
import { TokenService } from "./services/token-service.js";

async function main() {
  const config = loadConfig();

  console.log("Creating indexes...");
  await DatabaseAccessor.ensureIndexes();
  console.log("Indexes ready");

  TokenService.setKeys(config.JWT_PRIVATE_KEY, config.JWT_PUBLIC_KEY);
  console.log("JWT keys loaded");

  const app = await buildApp();

  const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`Server listening at ${address}`);

  const signals = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`Received ${signal}, shutting down gracefully...`);
      await app.close();
      await closeDb();
      process.exit(0);
    });
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

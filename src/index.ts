import { loadConfig } from "./config.js";
import { connectDb, closeDb } from "./db/client.js";
import { ensureIndexes } from "./db/collections.js";
import { buildApp } from "./server.js";

async function main() {
  const config = loadConfig();

  console.log("Connecting to MongoDB...");
  await connectDb(config.MONGODB_URI);
  console.log("MongoDB connected");

  console.log("Creating indexes...");
  await ensureIndexes();
  console.log("Indexes ready");

  const app = await buildApp();

  const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`Server listening at ${address}`);

  // Graceful shutdown
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

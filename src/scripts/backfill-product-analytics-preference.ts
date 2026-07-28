#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { MongoDbConnector } from "../db/mongo-db-connector.js";
import { UserRepository } from "../repositories/user-repo.js";

export type ProductAnalyticsPreferenceBackfillCliOptions = {
  apply: boolean;
  help: boolean;
};

export function parseProductAnalyticsPreferenceBackfillArgs(input: {
  argv: string[];
}): ProductAnalyticsPreferenceBackfillCliOptions {
  const options: ProductAnalyticsPreferenceBackfillCliOptions = { apply: false, help: false };
  for (const argument of input.argv) {
    if (argument === "--apply") {
      options.apply = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function printProductAnalyticsPreferenceBackfillUsage(): void {
  console.log("Usage: npm run backfill-product-analytics-preference -- [options]");
  console.log();
  console.log("Options:");
  console.log("  --apply      Backfill missing required fields (default: count and validate only)");
  console.log("  --help, -h   Show this help");
  console.log();
  console.log("Requires MONGODB_URI. Example with SOPS env:");
  console.log("  sops exec-env env/app/prod.env 'npm run backfill-product-analytics-preference -- --apply'");
}

export async function runProductAnalyticsPreferenceBackfillCli(input: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  let options: ProductAnalyticsPreferenceBackfillCliOptions;
  try {
    options = parseProductAnalyticsPreferenceBackfillArgs({ argv: input.argv });
  } catch (error) {
    console.error("Invalid product analytics preference backfill arguments:", error);
    printProductAnalyticsPreferenceBackfillUsage();
    return 1;
  }

  if (options.help) {
    printProductAnalyticsPreferenceBackfillUsage();
    return 0;
  }

  const env = input.env ?? process.env;
  if (!env.MONGODB_URI) {
    console.error("MONGODB_URI environment variable is required");
    return 1;
  }

  let connector: MongoDbConnector | null = null;
  try {
    connector = new MongoDbConnector({
      connectionString: env.MONGODB_URI,
      clientOptions: { appName: "sesori-product-analytics-preference-backfill" },
    });
    const userRepo = new UserRepository(new MongoDbAccessor(connector));
    const missingBefore = await userRepo.countUsersMissingProductAnalyticsPreference();
    const result = options.apply
      ? await userRepo.backfillProductAnalyticsPreference()
      : { matchedCount: 0, modifiedCount: 0 };
    const missingAfter = await userRepo.countUsersMissingProductAnalyticsPreference();

    console.log("[ProductAnalyticsPreferenceBackfill] Report", {
      mode: options.apply ? "apply" : "validate",
      missingBefore,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      missingAfter,
    });
    return missingAfter === 0 ? 0 : 1;
  } catch (error) {
    console.error("Product analytics preference backfill failed:", error);
    return 1;
  } finally {
    await connector?.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runProductAnalyticsPreferenceBackfillCli({ argv: process.argv.slice(2) });
}

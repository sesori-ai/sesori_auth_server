#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { MongoDbConnector } from "../db/mongo-db-connector.js";
import { productAnalyticsPreferenceBackfillMaxBatchLimit, UserRepository } from "../repositories/user-repo.js";

const DEFAULT_BATCH_LIMIT = 500;

export type ProductAnalyticsPreferenceBackfillCliOptions = {
  apply: boolean;
  help: boolean;
  batchLimit: number;
};

function parseBatchLimit(input: { value: string }): number {
  if (input.value.trim() === "") {
    throw new Error("--batch-limit requires a value");
  }
  const parsed = Number(input.value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > productAnalyticsPreferenceBackfillMaxBatchLimit) {
    throw new Error(
      `--batch-limit must be an integer between 1 and ${productAnalyticsPreferenceBackfillMaxBatchLimit}`,
    );
  }
  return parsed;
}

export function parseProductAnalyticsPreferenceBackfillArgs(input: {
  argv: string[];
}): ProductAnalyticsPreferenceBackfillCliOptions {
  const options: ProductAnalyticsPreferenceBackfillCliOptions = {
    apply: false,
    help: false,
    batchLimit: DEFAULT_BATCH_LIMIT,
  };
  for (let index = 0; index < input.argv.length; index += 1) {
    const argument = input.argv[index];
    if (argument === "--apply") {
      options.apply = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument.startsWith("--batch-limit=")) {
      options.batchLimit = parseBatchLimit({ value: argument.slice("--batch-limit=".length) });
      continue;
    }
    if (argument === "--batch-limit") {
      const value = input.argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--batch-limit requires a value");
      }
      options.batchLimit = parseBatchLimit({ value });
      index += 1;
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
  console.log("  --batch-limit <n>  Users processed per batch (default: 500; maximum: 1000)");
  console.log("  --help, -h   Show this help");
  console.log();
  console.log("Requires MONGODB_URI. Example with SOPS env:");
  console.log("  sops exec-env env/app/prod.env 'npm run backfill-product-analytics-preference -- --batch-limit 500'");
  console.log(
    "  sops exec-env env/app/prod.env 'npm run backfill-product-analytics-preference -- --apply --batch-limit 500'",
  );
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
    let afterUserId: string | null = null;
    let batchesCompleted = 0;
    let usersFound = 0;
    let matchedCount = 0;
    let modifiedCount = 0;
    while (true) {
      const userIds = await userRepo.findProductAnalyticsPreferenceBackfillBatch({
        afterUserId,
        batchLimit: options.batchLimit,
      });
      if (userIds.length === 0) {
        break;
      }

      usersFound += userIds.length;
      if (options.apply) {
        const result = await userRepo.backfillProductAnalyticsPreferenceBatch({ userIds });
        matchedCount += result.matchedCount;
        modifiedCount += result.modifiedCount;
      }
      batchesCompleted += 1;
      afterUserId = userIds[userIds.length - 1];
      console.log("[ProductAnalyticsPreferenceBackfill] Batch completed", {
        mode: options.apply ? "apply" : "validate",
        batchesCompleted,
        usersFound,
        matchedCount,
        modifiedCount,
      });
      if (userIds.length < options.batchLimit) {
        break;
      }
    }

    console.log("[ProductAnalyticsPreferenceBackfill] Report", {
      mode: options.apply ? "apply" : "validate",
      batchLimit: options.batchLimit,
      batchesCompleted,
      usersFound,
      matchedCount,
      modifiedCount,
      missingAfter: options.apply ? 0 : usersFound,
    });
    return options.apply || usersFound === 0 ? 0 : 1;
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

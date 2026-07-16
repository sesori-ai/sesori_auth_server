#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { MongoDbConnector } from "../db/mongo-db-connector.js";
import { ActivationStateRepository } from "../repositories/activation-state-repo.js";
import { BridgeRepository } from "../repositories/bridge-repo.js";
import { DailyUsageRepository } from "../repositories/daily-usage-repo.js";
import { DeviceTokenRepository } from "../repositories/device-token-repo.js";
import { UserRepository } from "../repositories/user-repo.js";
import { ActivationBackfillMode, ActivationBackfillService } from "../services/activation-backfill-service.js";

const DEFAULT_BATCH_LIMIT = 500;
const DEFAULT_JITTER_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ActivationBackfillCliOptions = {
  apply: boolean;
  help: boolean;
  batchLimit: number;
  jitterWindowMs: number;
  backfillAt: Date;
};

function parseInteger(value: string, flag: string, minimum: number): number {
  if (value.trim() === "") {
    throw new Error(`${flag} requires a value`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${flag} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function flagValue(argv: string[], index: number, name: string): { value: string; nextIndex: number } | null {
  const argument = argv[index];
  if (argument.startsWith(`${name}=`)) {
    return { value: argument.slice(name.length + 1), nextIndex: index };
  }

  if (argument === name) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }

    return { value, nextIndex: index + 1 };
  }
  return null;
}

export function parseActivationBackfillArgs(argv: string[], now = new Date()): ActivationBackfillCliOptions {
  const options: ActivationBackfillCliOptions = {
    apply: false,
    help: false,
    batchLimit: DEFAULT_BATCH_LIMIT,
    jitterWindowMs: DEFAULT_JITTER_WINDOW_MS,
    backfillAt: now,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    if (argument === "--apply") {
      options.apply = true;
      continue;
    }

    const batchLimit = flagValue(argv, index, "--batch-limit");
    if (batchLimit) {
      options.batchLimit = parseInteger(batchLimit.value, "--batch-limit", 1);
      index = batchLimit.nextIndex;
      continue;
    }
    const jitterWindow = flagValue(argv, index, "--jitter-window-ms");
    if (jitterWindow) {
      options.jitterWindowMs = parseInteger(jitterWindow.value, "--jitter-window-ms", 0);
      index = jitterWindow.nextIndex;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

export function printActivationBackfillUsage(): void {
  console.log("Usage: npm run backfill-activation -- [options]");
  console.log();
  console.log("Options:");
  console.log("  --apply                   Persist the proposed backfill (default: dry-run)");
  console.log("  --batch-limit <n>         Users loaded per batch (default: 500)");
  console.log("  --jitter-window-ms <n>    Deterministic spread window (default: 86400000 / 24h)");
  console.log("  --help, -h                Show this help");
  console.log();
  console.log("Requires MONGODB_URI. Example with SOPS env:");
  console.log("  sops exec-env env/app/prod.env 'npm run backfill-activation -- --jitter-window-ms 86400000'");
}

export async function runActivationBackfillCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let options: ActivationBackfillCliOptions;
  try {
    options = parseActivationBackfillArgs(argv);
  } catch (error) {
    console.error("Invalid activation backfill arguments:", error);
    printActivationBackfillUsage();
    return 1;
  }

  if (options.help) {
    printActivationBackfillUsage();
    return 0;
  }

  if (!env.MONGODB_URI) {
    console.error("MONGODB_URI environment variable is required");
    return 1;
  }

  let connector: MongoDbConnector | null = null;
  try {
    connector = new MongoDbConnector({
      connectionString: env.MONGODB_URI,
      clientOptions: { appName: "sesori-activation-backfill" },
    });
    const accessor = new MongoDbAccessor(connector);
    const service = new ActivationBackfillService({
      userRepo: new UserRepository(accessor),
      activationStateRepo: new ActivationStateRepository(accessor),
      bridgeRepo: new BridgeRepository(accessor),
      dailyUsageRepo: new DailyUsageRepository(accessor),
      deviceTokenRepo: new DeviceTokenRepository(accessor),
    });
    const mode = options.apply ? ActivationBackfillMode.Apply : ActivationBackfillMode.DryRun;
    console.log("[ActivationBackfill] Starting", {
      mode,
      backfillAt: options.backfillAt,
      batchLimit: options.batchLimit,
      jitterWindowMs: options.jitterWindowMs,
    });
    const report = await service.run({
      ...options,
      onBatchComplete: (progress) => {
        console.log("[ActivationBackfill] Batch completed", {
          mode: progress.mode,
          usersScanned: progress.usersScanned,
          usersProposed: progress.usersProposed,
          usersApplied: progress.usersApplied,
          usersAlreadyBackfilled: progress.usersAlreadyBackfilled,
          usersFailed: progress.usersFailed,
        });
      },
    });
    console.log("[ActivationBackfill] Report", report);
    return report.usersFailed === 0 ? 0 : 1;
  } catch (error) {
    console.error("Activation backfill failed:", error);
    return 1;
  } finally {
    await connector?.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runActivationBackfillCli(process.argv.slice(2));
}

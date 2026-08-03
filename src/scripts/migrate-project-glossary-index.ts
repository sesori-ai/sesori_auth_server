#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadGlossaryMigrationConfig } from "../config.js";
import {
  GlossaryIndexMigrationMode,
  GlossaryIndexMigrationOutcome,
  GlossaryIndexMigrationPersistenceError,
  runGlossaryIndexMigration,
} from "../db/glossary-index-migration.js";
import { MongoDbConnector } from "../db/mongo-db-connector.js";
import { safeErrorType } from "../lib/errors.js";
import { MongoDbDatabase } from "../types/mongo.js";

export type ProjectGlossaryIndexMigrationCliOptions = {
  mode: GlossaryIndexMigrationMode;
  help: boolean;
};

const modeByFlag = new Map<string, GlossaryIndexMigrationMode>([
  ["--apply", GlossaryIndexMigrationMode.Apply],
  ["--verify", GlossaryIndexMigrationMode.Verify],
  ["--rollback", GlossaryIndexMigrationMode.Rollback],
]);

export function parseProjectGlossaryIndexMigrationArgs(argv: string[]): ProjectGlossaryIndexMigrationCliOptions {
  let selectedMode: GlossaryIndexMigrationMode | null = null;
  let help = false;

  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      if (help || selectedMode) {
        throw new Error("InvalidProjectGlossaryIndexMigrationArguments");
      }
      help = true;
      continue;
    }

    const mode = modeByFlag.get(argument);
    if (!mode || selectedMode || help) {
      throw new Error("InvalidProjectGlossaryIndexMigrationArguments");
    }
    selectedMode = mode;
  }

  return { mode: selectedMode ?? GlossaryIndexMigrationMode.DryRun, help };
}

export function printProjectGlossaryIndexMigrationUsage(): void {
  console.log("Usage: npm run migrate-project-glossary-index -- [--apply | --verify | --rollback]");
  console.log();
  console.log("No mode flag performs a read-only dry-run. Mutating modes require the documented stopped-auth window.");
}

export async function runProjectGlossaryIndexMigrationCli(input: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  let options: ProjectGlossaryIndexMigrationCliOptions;
  try {
    options = parseProjectGlossaryIndexMigrationArgs(input.argv);
  } catch {
    console.error("[ProjectGlossaryIndexMigration] Invalid arguments");
    printProjectGlossaryIndexMigrationUsage();
    return 1;
  }

  if (options.help) {
    printProjectGlossaryIndexMigrationUsage();
    return 0;
  }

  let connector: MongoDbConnector | null = null;
  try {
    const config = loadGlossaryMigrationConfig(input.env ?? process.env);
    connector = new MongoDbConnector({
      connectionString: config.mongodbUri,
      clientOptions: { appName: "sesori-project-glossary-index-migration" },
    });
    const report = await runGlossaryIndexMigration({
      db: connector.getDb(MongoDbDatabase.Auth),
      mode: options.mode,
    });
    console.log("[ProjectGlossaryIndexMigration] Report", report);
    return report.outcome === GlossaryIndexMigrationOutcome.Completed ? 0 : 1;
  } catch (error) {
    console.error("[ProjectGlossaryIndexMigration] Failed", {
      mode: options.mode,
      outcome: GlossaryIndexMigrationOutcome.RepairRequired,
      errorType: safeErrorType({ error }),
      ...(error instanceof GlossaryIndexMigrationPersistenceError ? { diagnostic: error.diagnostic } : {}),
    });
    return 1;
  } finally {
    await connector?.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runProjectGlossaryIndexMigrationCli({ argv: process.argv.slice(2) });
}

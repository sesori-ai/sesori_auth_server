#!/usr/bin/env node
/**
 * Operator command auditing and optionally deleting Soniox async residue left
 * by a hard crash. Ordinary requests clean up after themselves; this exists so
 * rare residue cannot silently accumulate toward provider storage caps.
 *
 * Defaults to a read-only audit. Prints counts and an outcome only — never IDs,
 * filenames, transcript content, or provider messages.
 */
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadSonioxPurgeConfig } from "../config.js";
import { safeErrorType } from "../lib/errors.js";
import { SONIOX_REST_URL_BY_REGION } from "../types/transcription.js";

const DEFAULT_PURGE_TIMEOUT_MS = 10_000;

export type SonioxPurgeMode = "audit" | "apply";

export type SonioxPurgeReport = {
  mode: SonioxPurgeMode;
  outcome: "completed" | "failed";
  fileCount: number;
  transcriptionCount: number;
  deletedFileCount: number;
  deletedTranscriptionCount: number;
};

/** The narrow SDK slice the purge command needs. */
export type SonioxPurgeSdk = {
  files: {
    list(): Promise<AsyncIterable<{ id: string }>>;
    delete(fileId: string, signal?: AbortSignal): Promise<void>;
  };
  stt: {
    list(): Promise<AsyncIterable<{ id: string }>>;
    delete(id: string, signal?: AbortSignal): Promise<void>;
  };
};

export function parseSonioxPurgeArgs(argv: string[]): { mode: SonioxPurgeMode; help: boolean } {
  let mode: SonioxPurgeMode = "audit";
  let help = false;

  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }

    if (argument === "--apply" && mode === "audit") {
      mode = "apply";
      continue;
    }

    throw new Error("InvalidSonioxPurgeArguments");
  }

  return { mode, help };
}

export function printSonioxPurgeUsage(): void {
  console.log("Usage: npm run purge-soniox-transcription -- [--apply]");
  console.log();
  console.log("Without --apply the command only audits residue. --apply deletes every listed resource.");
  console.log();
  console.log("Run --apply only while no Soniox transcription traffic is in flight: it deletes every");
  console.log("listed file and job, including one an active request just created.");
}

const purgeItemSchema = z.object({ id: z.string().min(1) }).loose();

export async function runSonioxPurge(input: {
  sdk: SonioxPurgeSdk;
  mode: SonioxPurgeMode;
  timeoutMs?: number;
}): Promise<SonioxPurgeReport> {
  const report: SonioxPurgeReport = {
    mode: input.mode,
    outcome: "completed",
    fileCount: 0,
    transcriptionCount: 0,
    deletedFileCount: 0,
    deletedTranscriptionCount: 0,
  };
  const timeoutMs = input.timeoutMs ?? DEFAULT_PURGE_TIMEOUT_MS;

  const markFailed = (stage: string, error: unknown): void => {
    console.error("[SonioxPurge] failed", { stage, errorType: safeErrorType({ error }) });
    report.outcome = "failed";
  };

  /** Deletes one resource. A single failure must not abandon the rest of the sweep. */
  const deleteOne = async (remove: (signal: AbortSignal) => Promise<void>, stage: string): Promise<boolean> => {
    try {
      await remove(AbortSignal.timeout(timeoutMs));
      return true;
    } catch (error) {
      markFailed(stage, error);
      return false;
    }
  };

  // Tracks whether any job may still exist. Deleting a file whose transcription
  // survived would leave a job referencing missing audio — the same unsafe state
  // the request-path cleanup avoids.
  let transcriptionsFullyCleared = true;

  // Transcriptions first: they reference files.
  try {
    for await (const item of await input.sdk.stt.list()) {
      const parsed = purgeItemSchema.safeParse(item);
      if (!parsed.success) {
        markFailed("transcription_item", parsed.error.issues);
        transcriptionsFullyCleared = false;
        continue;
      }

      report.transcriptionCount += 1;
      const removed =
        input.mode === "apply" &&
        (await deleteOne((signal) => input.sdk.stt.delete(parsed.data.id, signal), "transcription_delete"));
      if (removed) {
        report.deletedTranscriptionCount += 1;
      } else if (input.mode === "apply") {
        transcriptionsFullyCleared = false;
      }
    }
  } catch (error) {
    markFailed("transcription_list", error);
    transcriptionsFullyCleared = false;
  }

  try {
    for await (const item of await input.sdk.files.list()) {
      const parsed = purgeItemSchema.safeParse(item);
      if (!parsed.success) {
        markFailed("file_item", parsed.error.issues);
        continue;
      }

      report.fileCount += 1;
      const removed =
        input.mode === "apply" &&
        transcriptionsFullyCleared &&
        (await deleteOne((signal) => input.sdk.files.delete(parsed.data.id, signal), "file_delete"));
      if (removed) {
        report.deletedFileCount += 1;
      }
    }
  } catch (error) {
    markFailed("file_list", error);
  }

  return report;
}

export async function runSonioxPurgeCli(input: { argv: string[]; env?: NodeJS.ProcessEnv }): Promise<number> {
  let options: { mode: SonioxPurgeMode; help: boolean };
  try {
    options = parseSonioxPurgeArgs(input.argv);
  } catch {
    printSonioxPurgeUsage();
    return 1;
  }

  if (options.help) {
    printSonioxPurgeUsage();
    return 0;
  }

  const config = loadSonioxPurgeConfig(input.env ?? process.env);
  const { SonioxNodeClient } = await import("@soniox/node");
  const sdk: SonioxPurgeSdk = new SonioxNodeClient({
    api_key: config.apiKey,
    region: config.region,
    base_url: SONIOX_REST_URL_BY_REGION[config.region],
  });

  const report = await runSonioxPurge({ sdk, mode: options.mode });
  console.log("[SonioxPurge] Report", report);
  return report.outcome === "completed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSonioxPurgeCli({ argv: process.argv.slice(2) })
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[SonioxPurge] failed", { errorType: safeErrorType({ error }) });
      process.exit(1);
    });
}

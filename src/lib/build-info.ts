import { readFileSync } from "node:fs";

/** Reported by `GET /version` when the deploy platform did not bind a commit. */
export const UNKNOWN_COMMIT = "unknown";

const BUILT_AT_FILE = "built-at.txt";
const ISO_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * The Dockerfile writes `dist/built-at.txt` next to the compiled entrypoint,
 * so it resolves beside the module that asks for it. Local `tsx` runs have no
 * such file under `src/`.
 */
export function getBuiltAtUrl(moduleUrl: string): URL {
  return new URL(`./${BUILT_AT_FILE}`, moduleUrl);
}

/**
 * Returns the image build time as ISO-8601 UTC, or null when the file is
 * missing or holds anything else. Never throws: a diagnostic value must not
 * keep the server from starting.
 */
export function readBuiltAt(file: URL): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }

  if (!ISO_UTC_SECONDS.test(raw) || Number.isNaN(Date.parse(raw))) {
    return null;
  }

  return raw;
}

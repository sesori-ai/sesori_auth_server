import { readFileSync } from "node:fs";

/** Reported by `GET /version` when neither the image build nor the environment supplied a commit. */
export const UNKNOWN_COMMIT = "unknown";

const BUILT_AT_FILE = "built-at.txt";
const COMMIT_FILE = "commit.txt";
const ISO_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const COMMIT_ID = /^[0-9a-f]{7,64}$/;

/**
 * The Dockerfile writes `dist/built-at.txt` and `dist/commit.txt` next to the
 * compiled entrypoint, so they resolve beside the module that asks for them.
 * Local `tsx` runs have no such files under `src/`.
 */
export function getBuiltAtUrl(moduleUrl: string): URL {
  return new URL(`./${BUILT_AT_FILE}`, moduleUrl);
}

export function getCommitUrl(moduleUrl: string): URL {
  return new URL(`./${COMMIT_FILE}`, moduleUrl);
}

/** Returns the value as a lowercase hex commit id, or null when it is anything else. */
export function parseCommitId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return COMMIT_ID.test(normalized) ? normalized : null;
}

/**
 * Returns the commit the Dockerfile resolved from the build context's `.git`,
 * or null when the file is missing or holds anything else (an empty file is
 * what a build context without git metadata produces). Never throws.
 */
export function readCommit(file: URL): string | null {
  try {
    return parseCommitId(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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

  if (!ISO_UTC_SECONDS.test(raw)) {
    return null;
  }

  // Date.parse rolls calendar-invalid days such as Feb 30 into the next month,
  // so only a value that survives a round trip unchanged is a real time.
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== raw.replace(/Z$/, ".000Z")) {
    return null;
  }

  return raw;
}

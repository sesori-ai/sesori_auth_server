#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const FORMAT = "sesori-plan-definition-v1";

function encodeLength(value) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

async function collectFiles(root, current, files) {
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, absolutePath, files);
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(`Unsupported non-file plan entry: ${absolutePath}`);
    }

    files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
  }
}

async function main() {
  const planArg = process.argv[2];
  if (!planArg || process.argv.length !== 3) {
    throw new Error("Usage: plan-definition-digest.mjs .plan/active/<plan-slug>");
  }

  const root = path.resolve(planArg);
  const planPath = path.join(root, "PLAN.md");
  const stagesPath = path.join(root, "stages");

  if (!(await lstat(planPath)).isFile()) {
    throw new Error(`Missing plan definition: ${planPath}`);
  }
  if (!(await lstat(stagesPath)).isDirectory()) {
    throw new Error(`Missing stages directory: ${stagesPath}`);
  }

  const files = ["PLAN.md"];
  const considerationsPath = path.join(root, "CONSIDERATIONS.md");
  try {
    if (!(await lstat(considerationsPath)).isFile()) {
      throw new Error(`Unsupported non-file plan entry: ${considerationsPath}`);
    }
    files.push("CONSIDERATIONS.md");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await collectFiles(root, stagesPath, files);
  files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  const hash = createHash("sha256");
  hash.update(FORMAT);
  hash.update("\0");

  for (const relativePath of files) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    const content = await readFile(path.join(root, relativePath));
    hash.update(encodeLength(pathBytes.length));
    hash.update(pathBytes);
    hash.update(encodeLength(content.length));
    hash.update(content);
  }

  process.stdout.write(`${FORMAT}:sha256:${hash.digest("hex")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});

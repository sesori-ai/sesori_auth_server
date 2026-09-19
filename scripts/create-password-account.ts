#!/usr/bin/env node
import { readFileSync } from "node:fs";
import argon2 from "argon2";
import { MongoDbConnector } from "../src/db/mongo-db-connector.js";
import { MongoDbAccessor } from "../src/db/mongo-db-accessor.js";
import { PasswordAccountRepository } from "../src/repositories/password-account-repo.js";
import { UserRepository } from "../src/repositories/user-repo.js";

type CliOptions = {
  email: string | undefined;
  passwordFromStdin: boolean;
  showHelp: boolean;
};

async function prompt({ question }: { question: string }): Promise<string> {
  const { default: readline } = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptPassword({ question }: { question: string }): Promise<string> {
  const { default: readline } = await import("node:readline");
  const { Writable } = await import("node:stream");
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: mutedOutput,
    terminal: true,
  });
  process.stdout.write(question);
  return new Promise((resolve) => {
    rl.on("line", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function parseOptions({ args }: { args: string[] }): CliOptions {
  const positional: string[] = [];
  let passwordFromStdin = false;
  let showHelp = false;
  for (const argument of args) {
    switch (argument) {
      case "--password-stdin":
        passwordFromStdin = true;
        break;
      case "--help":
      case "-h":
        showHelp = true;
        break;
      default:
        if (argument.startsWith("-")) {
          throw new Error("Unknown option");
        }
        positional.push(argument);
    }
  }
  if (positional.length > 1) {
    throw new Error("Do not pass passwords as process arguments; use --password-stdin or the hidden prompt");
  }
  return {
    email: positional[0],
    passwordFromStdin,
    showHelp,
  };
}

function readPasswordFromStdin(): string {
  const input = readFileSync(process.stdin.fd, "utf-8");
  const password = input.replace(/\r?\n$/, "");
  if (/[\r\n]/.test(password)) {
    throw new Error("Standard-input password must contain exactly one line");
  }
  return password;
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  npx tsx scripts/create-password-account.ts <email> --password-stdin");
  console.log("  npx tsx scripts/create-password-account.ts <email>                   # hidden prompt");
  console.log("  npx tsx scripts/create-password-account.ts                           # prompts for both");
  console.log();
  console.log("Requires MONGODB_URI environment variable.");
  console.log("Production SOPS example (this creates an account in production):");
  console.log(
    "  printf '%s\\n' \"$PASSWORD\" | sops exec-env env/app/prod.env " +
      "'npx tsx scripts/create-password-account.ts reviewer@example.com --password-stdin'",
  );
}

async function main(): Promise<void> {
  const options = parseOptions({ args: process.argv.slice(2) });
  if (options.showHelp) {
    printUsage();
    return;
  }

  const mongodbUri = process.env.MONGODB_URI;
  if (!mongodbUri) {
    throw new Error("MONGODB_URI environment variable is required");
  }

  const email = options.email ?? (await prompt({ question: "Email: " }));
  if (!email) {
    throw new Error("Email is required");
  }

  const password = options.passwordFromStdin
    ? readPasswordFromStdin()
    : await promptPassword({ question: "Password: " });
  if (!password) {
    throw new Error("Password is required");
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error("Invalid email format");
  }
  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const connector = new MongoDbConnector({ connectionString: mongodbUri });
  const accessor = new MongoDbAccessor(connector);
  try {
    await accessor.ensureIndexes();
    const passwordAccounts = new PasswordAccountRepository(accessor);
    const normalizedEmail = email.toLowerCase();
    const existing = await passwordAccounts.findByEmail(normalizedEmail);
    if (existing) {
      throw new Error(`An account with email '${normalizedEmail}' already exists`);
    }

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const user = await new UserRepository(accessor).create();
    await passwordAccounts.create({
      userId: user._id,
      email: normalizedEmail,
      passwordHash: hash,
    });

    console.log("Password account created successfully");
    console.log(`Email: ${normalizedEmail}`);
  } finally {
    await connector.close();
  }
}

main().catch((error: unknown) => {
  console.error("Error creating account:", error);
  process.exitCode = 1;
});

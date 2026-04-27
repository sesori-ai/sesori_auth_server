#!/usr/bin/env node
import { ObjectId } from "mongodb";
import argon2 from "argon2";
import { MongoDbConnector } from "../src/db/mongo-db-connector.js";
import { MongoDbAccessor } from "../src/db/mongo-db-accessor.js";
import { MongoDbDatabase, AuthDbCollection } from "../src/types/mongo.js";
import type { User, PasswordAccount } from "../src/models/documents.js";

async function prompt(question: string): Promise<string> {
  const { default: readline } = await import("readline");
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

async function promptPassword(question: string): Promise<string> {
  const { default: readline } = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.on("data", (char: Buffer) => {
      const s = char.toString();
      switch (s) {
        case "\n":
        case "\r":
        case "\u0004":
          stdin.pause();
          break;
        default:
          process.stdout.write("*");
          break;
      }
    });

    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  npx tsx scripts/create-password-account.ts <email> <password>");
  console.log("  npx tsx scripts/create-password-account.ts <email>         # prompts for password");
  console.log("  npx tsx scripts/create-password-account.ts                 # prompts for both");
  console.log();
  console.log("Requires MONGODB_URI environment variable.");
  console.log("Example with SOPS env:");
  console.log("  sops exec-env env/app/local.env 'npx tsx scripts/create-password-account.ts reviewer@example.com mypassword'");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
  }

  const mongodbUri = process.env.MONGODB_URI;
  if (!mongodbUri) {
    console.error("Error: MONGODB_URI environment variable is required.");
    console.error();
    console.error("You can provide it via a .env file or SOPS:");
    console.error("  sops exec-env env/app/local.env 'npx tsx scripts/create-password-account.ts ...'");
    process.exit(1);
  }

  let email = args[0];
  let password = args[1];

  if (!email) {
    email = await prompt("Email: ");
    if (!email) {
      console.error("Error: Email is required.");
      process.exit(1);
    }
  }

  if (!password) {
    password = await promptPassword("Password: ");
    if (!password) {
      console.error("Error: Password is required.");
      process.exit(1);
    }
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.error("Error: Invalid email format.");
    process.exit(1);
  }

  if (password.length < 6) {
    console.error("Error: Password must be at least 6 characters.");
    process.exit(1);
  }

  const connector = new MongoDbConnector({
    connectionString: mongodbUri,
  });

  const accessor = new MongoDbAccessor(connector);

  try {
    await accessor.ensureIndexes();

    const userCollection = accessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
    const passwordCollection = accessor.getCollection<PasswordAccount>(
      MongoDbDatabase.Auth,
      AuthDbCollection.PasswordAccounts,
    );

    const existing = await passwordCollection.findOne({ email: email.toLowerCase() });
    if (existing) {
      console.error(`Error: An account with email '${email}' already exists (userId: ${existing.userId.toHexString()}).`);
      process.exit(1);
    }

    const userId = new ObjectId();
    const now = new Date();

    const user: User = {
      _id: userId,
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    await userCollection.insertOne(user);

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const passwordAccount: PasswordAccount = {
      _id: new ObjectId(),
      userId,
      email: email.toLowerCase(),
      passwordHash: hash,
      createdAt: now,
      updatedAt: now,
    };
    await passwordCollection.insertOne(passwordAccount);

    console.log("✅ Password account created successfully");
    console.log(`   User ID:  ${userId.toHexString()}`);
    console.log(`   Email:    ${passwordAccount.email}`);
    console.log(`   Database: ${MongoDbDatabase.Auth} / ${AuthDbCollection.PasswordAccounts}`);
  } catch (error) {
    console.error("Error creating account:", error);
    process.exit(1);
  } finally {
    await connector.close();
  }
}

main();

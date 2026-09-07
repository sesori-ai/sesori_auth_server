import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ObjectId } from "mongodb";
import { describe, it } from "node:test";
import type { OAuthAccount } from "../../src/models/documents.js";
import {
  createOptionalEmailTestSendRuntime,
  runOptionalEmailTestSendCli,
} from "../../src/scripts/send-test-setup-reminder.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp } from "../helpers/setup.js";

const VALID_ARGS = [
  "--user-id",
  "507f1f77bcf86cd799439011",
  "--operation-id",
  "manual_smoke_1",
  "--template",
  "bridge_setup",
  "--confirm-recipient",
  "alex@sesori.com",
  "--confirm-send",
  "SEND_ONE_TEST_EMAIL",
];

const VALID_ENABLED_ENV: NodeJS.ProcessEnv = {
  MONGODB_URI: "mongodb://isolated.invalid/auth",
  OPTIONAL_EMAIL_SENDING_ENABLED: "true",
  OPTIONAL_EMAIL_TEST_SEND_ENABLED: "true",
  OPTIONAL_EMAIL_RECIPIENT_BASIS: "account_activity_approved",
  OPTIONAL_EMAIL_DAILY_CAP: "80",
  RESEND_API_KEY: "re_placeholder_not_a_secret",
  RESEND_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 3).toString("base64")}`,
  OPTIONAL_EMAIL_UNSUBSCRIBE_SIGNING_SECRET: "u".repeat(32),
  AUTH_BASE_URL: "https://api.sesori.com",
};

describe("send-test-setup-reminder CLI", () => {
  it("fails before runtime construction while either send gate is disabled", async () => {
    for (const env of [
      { MONGODB_URI: "mongodb://isolated.invalid/auth" },
      {
        MONGODB_URI: "mongodb://isolated.invalid/auth",
        OPTIONAL_EMAIL_SENDING_ENABLED: "true",
      },
    ]) {
      const output: string[] = [];
      const exitCode = await runOptionalEmailTestSendCli(VALID_ARGS, env, {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        createRuntime: async () => {
          throw new Error("test-send runtime must remain unconstructed");
        },
      });

      assert.equal(exitCode, 1);
      assert.deepEqual(output, ["Optional-email test send is disabled"]);
    }
  });

  it("fails closed without an explicitly approved basis and complete signing config", async () => {
    const output: string[] = [];
    const exitCode = await runOptionalEmailTestSendCli(
      VALID_ARGS,
      {
        MONGODB_URI: "mongodb://isolated.invalid/auth",
        OPTIONAL_EMAIL_SENDING_ENABLED: "true",
        OPTIONAL_EMAIL_TEST_SEND_ENABLED: "true",
        RESEND_API_KEY: "re_placeholder_not_a_secret",
        RESEND_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 3).toString("base64")}`,
        OPTIONAL_EMAIL_UNSUBSCRIBE_SIGNING_SECRET: "u".repeat(32),
        AUTH_BASE_URL: "https://api.sesori.com",
      },
      {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        createRuntime: async () => {
          throw new Error("runtime must not be created without approved basis");
        },
      },
    );

    assert.equal(exitCode, 1);
    assert.deepEqual(output, ["Optional-email test send configuration is incomplete"]);
    assert.doesNotMatch(output.join("\n"), /re_placeholder|whsec|mongodb|api\.sesori/);
  });

  it("rejects a webhook secret that cannot verify Resend signatures", async () => {
    const output: string[] = [];
    const exitCode = await runOptionalEmailTestSendCli(
      VALID_ARGS,
      { ...VALID_ENABLED_ENV, RESEND_WEBHOOK_SECRET: "x".repeat(40) },
      {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        createRuntime: async () => {
          throw new Error("runtime must not be created with an invalid webhook secret");
        },
      },
    );

    assert.equal(exitCode, 1);
    assert.deepEqual(output, ["Optional-email test send configuration is incomplete"]);
  });

  it("rejects every recipient except the pinned test address", async () => {
    const args = [...VALID_ARGS];
    args[args.indexOf("alex@sesori.com")] = "other@example.test";
    const output: string[] = [];
    const exitCode = await runOptionalEmailTestSendCli(args, VALID_ENABLED_ENV, {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      createRuntime: async () => {
        throw new Error("runtime must not be created for a non-allowlisted recipient");
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(output, ["Invalid optional-email test-send arguments"]);
    assert.doesNotMatch(output.join("\n"), /other@example|alex@sesori/);
  });

  it("requires the literal one-test-email operator confirmation", async () => {
    const args = [...VALID_ARGS];
    args[args.indexOf("SEND_ONE_TEST_EMAIL")] = "SEND_EMAILS";
    const output: string[] = [];
    const exitCode = await runOptionalEmailTestSendCli(args, VALID_ENABLED_ENV, {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      createRuntime: async () => {
        throw new Error("runtime must not be created without exact confirmation");
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(output, ["Invalid optional-email test-send arguments"]);
  });

  it("rejects a non-canonical Mongo user id", async () => {
    const args = [...VALID_ARGS];
    args[args.indexOf("507f1f77bcf86cd799439011")] = "not-a-user-id";
    const output: string[] = [];
    const exitCode = await runOptionalEmailTestSendCli(args, VALID_ENABLED_ENV, {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      createRuntime: async () => {
        throw new Error("runtime must not be created for an invalid user id");
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(output, ["Invalid optional-email test-send arguments"]);
  });

  it("rejects an operation id that is not a short slug", async () => {
    const args = [...VALID_ARGS];
    args[args.indexOf("manual_smoke_1")] = "manual smoke / address@example.test";
    const output: string[] = [];
    const exitCode = await runOptionalEmailTestSendCli(args, VALID_ENABLED_ENV, {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      createRuntime: async () => {
        throw new Error("runtime must not be created for an invalid operation id");
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(output, ["Invalid optional-email test-send arguments"]);
    assert.doesNotMatch(output.join("\n"), /address@example/);
  });

  it("rejects any template outside the two setup reminders", async () => {
    const args = [...VALID_ARGS];
    args[args.indexOf("bridge_setup")] = "bulk_campaign";
    const output: string[] = [];
    const exitCode = await runOptionalEmailTestSendCli(args, VALID_ENABLED_ENV, {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      createRuntime: async () => {
        throw new Error("runtime must not be created for an invalid template");
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(output, ["Invalid optional-email test-send arguments"]);
  });

  it("rejects unexpected or duplicate argument pairs", async () => {
    const output: string[] = [];
    const exitCode = await runOptionalEmailTestSendCli(
      [...VALID_ARGS, "--recipient", "customer@example.test"],
      VALID_ENABLED_ENV,
      {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        createRuntime: async () => {
          throw new Error("runtime must not be created for unexpected arguments");
        },
      },
    );

    assert.equal(exitCode, 1);
    assert.deepEqual(output, ["Invalid optional-email test-send arguments"]);
    assert.doesNotMatch(output.join("\n"), /customer@example/);
  });

  it("runs exactly one allowlisted test send and prints no recipient or user", async () => {
    const output: string[] = [];
    let closed = false;
    let runtimeInput: unknown;
    let runtimeConfig: unknown;
    const exitCode = await runOptionalEmailTestSendCli(VALID_ARGS, VALID_ENABLED_ENV, {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      createRuntime: async (config) => {
        runtimeConfig = config;
        return {
          send: async (input) => {
            runtimeInput = input;
            return {
              status: "sent",
              sendKey: "optional/opaque-test-key",
              providerEmailId: "resend_test_1",
            };
          },
          close: async () => {
            closed = true;
          },
        };
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(closed, true);
    assert.deepEqual(runtimeInput, {
      userId: "507f1f77bcf86cd799439011",
      operationId: "manual_smoke_1",
      template: "bridge_setup",
      recipient: "alex@sesori.com",
    });
    assert.deepEqual(runtimeConfig, {
      mongoUri: "mongodb://isolated.invalid/auth",
      resendApiKey: "re_placeholder_not_a_secret",
      webhookSigningSecret: VALID_ENABLED_ENV.RESEND_WEBHOOK_SECRET,
      unsubscribeSigningSecret: "u".repeat(32),
      publicBaseUrl: "https://api.sesori.com",
      from: "Sesori <hello@updates.sesori.com>",
      replyTo: "hello@sesori.com",
      testRecipient: "alex@sesori.com",
      dailyCap: 80,
      recipientBasis: "account_activity_approved",
    });
    assert.deepEqual(output, [
      '{"status":"sent","sendKey":"optional/opaque-test-key","providerEmailId":"resend_test_1"}',
    ]);
    assert.doesNotMatch(output[0] ?? "", /@|507f1f77|re_placeholder|whsec/);
  });

  it("closes and sanitizes a runtime failure", async () => {
    const output: string[] = [];
    let closed = false;
    const exitCode = await runOptionalEmailTestSendCli(VALID_ARGS, VALID_ENABLED_ENV, {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      createRuntime: async () => ({
        send: async () => {
          throw new Error("alex@sesori.com mongodb://private re_private");
        },
        close: async () => {
          closed = true;
        },
      }),
    });

    assert.equal(exitCode, 1);
    assert.equal(closed, true);
    assert.deepEqual(output, ["Optional-email test send failed"]);
  });

  it("uses isolated Mongo state and injected fetch for the real runtime", async () => {
    const ctx = await createTestApp();
    try {
      const user = await ctx.createUser();
      await ctx.dbAccessor
        .getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts)
        .updateOne({ userId: new ObjectId(user.userId) }, { $set: { email: "alex@sesori.com" } });

      let requestCount = 0;
      const runtime = await createOptionalEmailTestSendRuntime(
        {
          mongoUri: process.env.MONGODB_URI!,
          resendApiKey: "re_placeholder_not_a_secret",
          webhookSigningSecret: `whsec_${Buffer.alloc(32, 3).toString("base64")}`,
          unsubscribeSigningSecret: "u".repeat(32),
          publicBaseUrl: "https://api.sesori.com",
          from: "Sesori <hello@updates.sesori.com>",
          replyTo: "hello@sesori.com",
          testRecipient: "alex@sesori.com",
          dailyCap: 80,
          recipientBasis: "account_activity_approved",
        },
        {
          fetchFn: async () => {
            requestCount += 1;
            return new Response(JSON.stringify({ id: "resend_isolated_1" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      );
      const result = await runtime.send({
        userId: user.userId,
        operationId: "isolated_smoke_1",
        template: "bridge_setup",
        recipient: "alex@sesori.com",
      });
      await runtime.close();

      assert.equal(result.status, "sent");
      assert.equal(requestCount, 1);
    } finally {
      await ctx.cleanup();
    }
  });

  it("prints help without reading send configuration", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/scripts/send-test-setup-reminder.ts", "--help"],
      { cwd: process.cwd(), encoding: "utf8", env: {} },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: npm run optional-email:test-send --/);
    assert.equal(result.stderr, "");
  });
});

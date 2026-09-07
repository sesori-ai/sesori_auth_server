import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import {
  createOptionalEmailDryRunRuntime,
  parseOptionalEmailDryRunArgs,
  runOptionalEmailDryRunCli,
} from "../../src/scripts/dry-run-setup-reminders.js";
import {
  OptionalEmailDryRunMode,
  OptionalEmailRecipientBasis,
  OptionalEmailReminderKind,
  OptionalEmailSendBlockReason,
} from "../../src/types/optional-email.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("dry-run-setup-reminders CLI", () => {
  it("accepts only help and one bounded batch limit", () => {
    assert.deepEqual(parseOptionalEmailDryRunArgs([]), { help: false, batchLimit: 500 });
    assert.deepEqual(parseOptionalEmailDryRunArgs(["--help"]), { help: true, batchLimit: 500 });
    assert.deepEqual(parseOptionalEmailDryRunArgs(["--batch-limit", "25"]), {
      help: false,
      batchLimit: 25,
    });
    assert.deepEqual(parseOptionalEmailDryRunArgs(["--batch-limit=10"]), {
      help: false,
      batchLimit: 10,
    });

    for (const argv of [
      ["--apply"],
      ["--send"],
      ["user@example.test"],
      ["--batch-limit"],
      ["--batch-limit", "0"],
      ["--batch-limit", "1001"],
      ["--batch-limit", "1.5"],
      ["--batch-limit", "10", "--batch-limit=20"],
    ]) {
      assert.throws(() => parseOptionalEmailDryRunArgs(argv));
    }
  });

  it("returns help and parser failures before configuration or runtime construction", async () => {
    const createRuntime = async () => {
      throw new Error("runtime must not be created");
    };
    const helpOutput: string[] = [];
    const helpExitCode = await runOptionalEmailDryRunCli(
      ["--help"],
      {},
      {
        stdout: (line) => helpOutput.push(line),
        stderr: (line) => helpOutput.push(`error:${line}`),
        createRuntime,
      },
    );
    assert.equal(helpExitCode, 0);
    assert.deepEqual(helpOutput, ["Usage: npm run optional-email:dry-run -- [--batch-limit 1..1000]"]);

    const invalidOutput: string[] = [];
    const invalidExitCode = await runOptionalEmailDryRunCli(
      ["--apply"],
      {},
      {
        stdout: (line) => invalidOutput.push(line),
        stderr: (line) => invalidOutput.push(line),
        createRuntime,
      },
    );
    assert.equal(invalidExitCode, 1);
    assert.deepEqual(invalidOutput, ["Invalid optional-email dry-run arguments"]);
  });

  it("prints one aggregate report without passing provider credentials to the runtime", async () => {
    const output: string[] = [];
    let runtimeConfig: unknown;
    let closeCount = 0;
    const report = {
      mode: OptionalEmailDryRunMode.DryRun,
      generatedAt: "2026-09-06T16:00:00.000Z",
      sendingEnabled: false,
      recipientBasis: OptionalEmailRecipientBasis.Unapproved,
      dailyCap: 80,
      usersScanned: 3,
      candidates: 2,
      segments: {
        [OptionalEmailReminderKind.BridgeSetup]: 1,
        [OptionalEmailReminderKind.FirstSession]: 1,
      },
      eligible: 0,
      blockedByReason: { [OptionalEmailSendBlockReason.RecipientBasisUnapproved]: 2 },
    };

    const exitCode = await runOptionalEmailDryRunCli(
      ["--batch-limit=25"],
      {
        MONGODB_URI: "mongodb://isolated-test.invalid/auth",
        OPTIONAL_EMAIL_SENDING_ENABLED: "false",
        OPTIONAL_EMAIL_RECIPIENT_BASIS: "unapproved",
        OPTIONAL_EMAIL_DAILY_CAP: "80",
        RESEND_API_KEY: "must-not-cross-runtime-boundary",
      },
      {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(`error:${line}`),
        createRuntime: async (config) => {
          runtimeConfig = config;
          return {
            run: async (input) => {
              assert.deepEqual(input, { batchLimit: 25 });
              return report;
            },
            close: async () => {
              closeCount += 1;
            },
          };
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(closeCount, 1);
    assert.deepEqual(runtimeConfig, {
      mongoUri: "mongodb://isolated-test.invalid/auth",
      sendingEnabled: false,
      recipientBasis: OptionalEmailRecipientBasis.Unapproved,
      dailyCap: 80,
    });
    assert.deepEqual(output, [JSON.stringify(report)]);
    assert.doesNotMatch(output.join("\n"), /must-not-cross-runtime-boundary|RESEND_API_KEY|@/);
  });

  it("fails closed on invalid narrow configuration without echoing values", async () => {
    const invalidEnvironments: NodeJS.ProcessEnv[] = [
      {},
      { MONGODB_URI: "mongodb://test.invalid", OPTIONAL_EMAIL_SENDING_ENABLED: "yes" },
      { MONGODB_URI: "mongodb://test.invalid", OPTIONAL_EMAIL_RECIPIENT_BASIS: "guessed" },
      { MONGODB_URI: "mongodb://test.invalid", OPTIONAL_EMAIL_DAILY_CAP: "81" },
    ];

    for (const env of invalidEnvironments) {
      const output: string[] = [];
      const exitCode = await runOptionalEmailDryRunCli([], env, {
        stdout: (line: string) => output.push(line),
        stderr: (line: string) => output.push(line),
        createRuntime: async () => {
          throw new Error("runtime must not be created for invalid configuration");
        },
      });

      assert.equal(exitCode, 1);
      assert.deepEqual(output, ["Invalid optional-email dry-run configuration"]);
      assert.doesNotMatch(output.join("\n"), /mongodb|yes|guessed|81/);
    }
  });

  it("closes once and sanitizes operational failures", async () => {
    const output: string[] = [];
    let closeCount = 0;
    const exitCode = await runOptionalEmailDryRunCli(
      [],
      { MONGODB_URI: "mongodb://isolated-test.invalid/auth" },
      {
        stdout: (line: string) => output.push(line),
        stderr: (line: string) => output.push(line),
        createRuntime: async () => ({
          run: async () => {
            throw new Error("failed while inspecting recipient@example.test at mongodb://secret");
          },
          close: async () => {
            closeCount += 1;
          },
        }),
      },
    );

    assert.equal(exitCode, 1);
    assert.equal(closeCount, 1);
    assert.deepEqual(output, ["Optional-email dry-run failed"]);
    assert.doesNotMatch(output.join("\n"), /recipient|@|mongodb|secret/);
  });

  describe("isolated Mongo runtime", () => {
    let ctx: TestContext;

    before(async () => {
      ctx = await createTestApp();
    });

    after(async () => {
      await ctx.cleanup();
    });

    it("evaluates aggregate eligibility without provider dependencies or writes", async () => {
      const user = await ctx.createUser();
      const mongoUri = process.env.MONGODB_URI;
      assert.ok(mongoUri);
      const preferences = ctx.dbAccessor.getCollection(MongoDbDatabase.Auth, AuthDbCollection.OptionalEmailPreferences);
      const beforeCount = await preferences.countDocuments();
      const runtime = await createOptionalEmailDryRunRuntime({
        mongoUri,
        sendingEnabled: false,
        recipientBasis: OptionalEmailRecipientBasis.Unapproved,
        dailyCap: 80,
      });

      try {
        const report = await runtime.run({ batchLimit: 10 });
        assert.equal(report.usersScanned, 1);
        assert.equal(report.candidates, 1);
        assert.deepEqual(report.segments, {
          [OptionalEmailReminderKind.BridgeSetup]: 1,
          [OptionalEmailReminderKind.FirstSession]: 0,
        });
        assert.equal(report.eligible, 0);
        assert.deepEqual(report.blockedByReason, {
          [OptionalEmailSendBlockReason.RecipientBasisUnapproved]: 1,
        });
        assert.equal(await preferences.countDocuments(), beforeCount);
        const serialized = JSON.stringify(report);
        assert.doesNotMatch(serialized, /"(?:userId|recipient|email)"\s*:/i);
        assert.doesNotMatch(serialized, new RegExp(user.userId));
        assert.doesNotMatch(serialized, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      } finally {
        await runtime.close();
      }
    });
  });

  it("runs the package command as help without database configuration", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
    delete env.MONGODB_URI;
    const result = spawnSync("npm", ["--silent", "run", "optional-email:dry-run", "--", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: npm run optional-email:dry-run -- \[--batch-limit 1\.\.1000\]/);
    assert.equal(result.stderr, "");
  });
});

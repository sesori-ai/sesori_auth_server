import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  createOptionalEmailDryRunRuntime,
  parseOptionalEmailDryRunArgs,
  runOptionalEmailDryRunCli,
} from "../../src/scripts/dry-run-setup-reminders.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { after, before } from "node:test";

describe("dry-run-setup-reminders CLI", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("supports only dry-run batch sizing and help", () => {
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
    assert.throws(() => parseOptionalEmailDryRunArgs(["--apply"]), /Unknown argument/);
    assert.throws(() => parseOptionalEmailDryRunArgs(["--send"]), /Unknown argument/);
    assert.throws(() => parseOptionalEmailDryRunArgs(["--batch-limit", "0"]), /batch-limit/);
  });

  it("contains parser failures before runtime construction", async () => {
    const output: string[] = [];
    const exitCode = await runOptionalEmailDryRunCli(
      ["--apply"],
      {},
      {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        createRuntime: async () => {
          throw new Error("runtime must not be created for invalid arguments");
        },
      },
    );

    assert.equal(exitCode, 1);
    assert.deepEqual(output, ["Invalid optional-email dry-run arguments"]);
  });

  it("prints one aggregate report without passing provider credentials to the runtime", async () => {
    const output: string[] = [];
    let runtimeConfig: unknown;
    let closed = false;
    const report = {
      mode: "dry_run" as const,
      generatedAt: "2026-09-06T16:00:00.000Z",
      sendingEnabled: false,
      recipientBasis: "unapproved" as const,
      dailyCap: 80,
      usersScanned: 3,
      candidates: 2,
      segments: { bridge_setup: 1, first_session: 1 },
      eligible: 0,
      blockedByReason: { recipient_basis_unapproved: 2 },
    };

    const exitCode = await runOptionalEmailDryRunCli(
      ["--batch-limit=25"],
      {
        MONGODB_URI: "mongodb://isolated-test.invalid/auth",
        OPTIONAL_EMAIL_SENDING_ENABLED: "false",
        OPTIONAL_EMAIL_RECIPIENT_BASIS: "unapproved",
        OPTIONAL_EMAIL_DAILY_CAP: "80",
        RESEND_API_KEY: "must-not-be-read",
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
              closed = true;
            },
          };
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(closed, true);
    assert.deepEqual(runtimeConfig, {
      mongoUri: "mongodb://isolated-test.invalid/auth",
      sendingEnabled: false,
      recipientBasis: "unapproved",
      dailyCap: 80,
    });
    assert.deepEqual(output, [JSON.stringify(report)]);
    assert.doesNotMatch(output.join("\n"), /must-not-be-read|RESEND_API_KEY|@/);
  });

  it("prints usage without reading configuration or creating a runtime", async () => {
    const output: string[] = [];
    const exitCode = await runOptionalEmailDryRunCli(
      ["--help"],
      {},
      {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(`error:${line}`),
        createRuntime: async () => {
          throw new Error("runtime must not be created for help");
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(output, ["Usage: npm run optional-email:dry-run -- [--batch-limit 1..1000]"]);
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
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        createRuntime: async () => {
          throw new Error("runtime must not be created for invalid config");
        },
      });

      assert.equal(exitCode, 1);
      assert.deepEqual(output, ["Invalid optional-email dry-run configuration"]);
      assert.doesNotMatch(output.join("\n"), /mongodb|yes|guessed|81/);
    }
  });

  it("closes the runtime and sanitizes operational failures", async () => {
    const output: string[] = [];
    let closed = false;
    const exitCode = await runOptionalEmailDryRunCli(
      [],
      { MONGODB_URI: "mongodb://isolated-test.invalid/auth" },
      {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        createRuntime: async () => ({
          run: async () => {
            throw new Error("failed while inspecting recipient@example.test at mongodb://secret");
          },
          close: async () => {
            closed = true;
          },
        }),
      },
    );

    assert.equal(exitCode, 1);
    assert.equal(closed, true);
    assert.deepEqual(output, ["Optional-email dry-run failed"]);
    assert.doesNotMatch(output.join("\n"), /recipient|@|mongodb|secret/);
  });

  it("builds the aggregate runtime against an isolated Mongo database", async () => {
    await ctx.createUser();
    const mongoUri = process.env.MONGODB_URI;
    assert.ok(mongoUri);
    const runtime = await createOptionalEmailDryRunRuntime({
      mongoUri,
      sendingEnabled: false,
      recipientBasis: "unapproved",
      dailyCap: 80,
    });

    try {
      const report = await runtime.run({ batchLimit: 10 });
      assert.equal(report.usersScanned, 1);
      assert.equal(report.candidates, 1);
      assert.deepEqual(report.segments, { bridge_setup: 1, first_session: 0 });
      assert.equal(report.eligible, 0);
      assert.deepEqual(report.blockedByReason, { recipient_basis_unapproved: 1 });
      const serialized = JSON.stringify(report);
      assert.doesNotMatch(serialized, /"(?:userId|recipient|email)"\s*:/i);
      assert.doesNotMatch(serialized, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    } finally {
      await runtime.close();
    }
  });

  it("runs directly as a help-only command without database configuration", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/scripts/dry-run-setup-reminders.ts", "--help"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "Usage: npm run optional-email:dry-run -- [--batch-limit 1..1000]");
    assert.equal(result.stderr, "");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSonioxPurgeArgs,
  runSonioxPurge,
  type SonioxPurgeSdk,
} from "../../src/scripts/purge-soniox-transcription.js";

function createSdk(
  files: { id: string }[],
  transcriptions: { id: string }[],
  options: { failOn?: "files" | "transcriptions" } = {},
): { sdk: SonioxPurgeSdk; deleted: string[] } {
  const deleted: string[] = [];

  return {
    deleted,
    sdk: {
      files: {
        async list() {
          if (options.failOn === "files") {
            throw new Error("list failed");
          }
          return files.values();
        },
        async delete(fileId: string) {
          deleted.push(`file:${fileId}`);
        },
      },
      stt: {
        async list() {
          if (options.failOn === "transcriptions") {
            throw new Error("list failed");
          }
          return transcriptions.values();
        },
        async delete(id: string) {
          deleted.push(`transcription:${id}`);
        },
      },
    },
  };
}

describe("purge-soniox-transcription", () => {
  describe("parseSonioxPurgeArgs", () => {
    it("defaults to audit and requires an explicit flag to delete", () => {
      assert.deepEqual(parseSonioxPurgeArgs([]), { mode: "audit", help: false });
      assert.deepEqual(parseSonioxPurgeArgs(["--apply"]), { mode: "apply", help: false });
      assert.equal(parseSonioxPurgeArgs(["--help"]).help, true);
    });

    it("rejects unknown and repeated flags", () => {
      for (const argv of [["--delete"], ["--apply", "--apply"], ["extra"]]) {
        assert.throws(() => parseSonioxPurgeArgs(argv), /InvalidSonioxPurgeArguments/);
      }
    });
  });

  describe("runSonioxPurge", () => {
    it("audits without deleting anything by default", async () => {
      const { sdk, deleted } = createSdk([{ id: "f1" }, { id: "f2" }], [{ id: "t1" }]);

      const report = await runSonioxPurge({ sdk, mode: "audit" });

      assert.deepEqual(report, {
        mode: "audit",
        outcome: "completed",
        fileCount: 2,
        transcriptionCount: 1,
        deletedFileCount: 0,
        deletedTranscriptionCount: 0,
      });
      assert.deepEqual(deleted, []);
    });

    it("deletes transcriptions before files when applying", async () => {
      const { sdk, deleted } = createSdk([{ id: "f1" }], [{ id: "t1" }]);

      const report = await runSonioxPurge({ sdk, mode: "apply" });

      assert.equal(report.outcome, "completed");
      assert.equal(report.deletedFileCount, 1);
      assert.equal(report.deletedTranscriptionCount, 1);
      assert.deepEqual(deleted, ["transcription:t1", "file:f1"]);
    });

    it("reports a failed outcome without throwing", async () => {
      const { sdk } = createSdk([], [], { failOn: "transcriptions" });

      const report = await runSonioxPurge({ sdk, mode: "audit" });

      assert.equal(report.outcome, "failed");
    });

    it("reports only counts, never identifiers", async () => {
      const { sdk } = createSdk([{ id: "secret-file-id" }], [{ id: "secret-transcription-id" }]);

      const report = await runSonioxPurge({ sdk, mode: "audit" });

      const serialized = JSON.stringify(report);
      assert.ok(!serialized.includes("secret-file-id"));
      assert.ok(!serialized.includes("secret-transcription-id"));
    });
  });
});

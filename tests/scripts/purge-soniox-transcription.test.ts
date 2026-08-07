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

    it("continues the sweep when one delete fails and still reports failure", async () => {
      const attempted: string[] = [];
      const sdk: SonioxPurgeSdk = {
        files: {
          async list() {
            return [{ id: "f1" }].values();
          },
          async delete(fileId: string) {
            attempted.push(`file:${fileId}`);
          },
        },
        stt: {
          async list() {
            return [{ id: "t1" }, { id: "t2" }].values();
          },
          async delete(id: string) {
            attempted.push(`transcription:${id}`);
            if (id === "t1") {
              throw new Error("delete failed");
            }
          },
        },
      };

      const report = await runSonioxPurge({ sdk, mode: "apply" });

      // One failure must not abandon the remaining transcriptions. Files are
      // then held back, because t1's job may still reference its audio.
      assert.deepEqual(attempted, ["transcription:t1", "transcription:t2"]);
      assert.equal(report.deletedTranscriptionCount, 1);
      assert.equal(report.deletedFileCount, 0);
      assert.equal(report.outcome, "failed");
    });

    it("skips a malformed list item instead of deleting an invalid id", async () => {
      const attempted: string[] = [];
      const sdk: SonioxPurgeSdk = {
        files: {
          async list() {
            return [].values();
          },
          async delete(fileId: string) {
            attempted.push(fileId);
          },
        },
        stt: {
          async list() {
            return [{ id: "" }, { notAnId: true }].values() as AsyncIterable<{ id: string }> | never;
          },
          async delete(id: string) {
            attempted.push(id);
          },
        },
      };

      const report = await runSonioxPurge({ sdk, mode: "apply" });

      assert.deepEqual(attempted, []);
      assert.equal(report.transcriptionCount, 0);
      assert.equal(report.outcome, "failed");
    });

    it("does not delete files when a transcription delete failed", async () => {
      const attempted: string[] = [];
      const sdk: SonioxPurgeSdk = {
        files: {
          async list() {
            return [{ id: "f1" }].values();
          },
          async delete(fileId: string) {
            attempted.push(`file:${fileId}`);
          },
        },
        stt: {
          async list() {
            return [{ id: "t1" }].values();
          },
          async delete(id: string) {
            attempted.push(`transcription:${id}`);
            throw new Error("delete failed");
          },
        },
      };

      const report = await runSonioxPurge({ sdk, mode: "apply" });

      // Removing audio whose job survived would leave a job referencing
      // missing audio, the same unsafe state request cleanup avoids.
      assert.deepEqual(attempted, ["transcription:t1"]);
      assert.equal(report.deletedFileCount, 0);
      assert.equal(report.fileCount, 1);
      assert.equal(report.outcome, "failed");
    });

    it("holds back the file sweep when a transcription list item is malformed", async () => {
      const attempted: string[] = [];
      const sdk: SonioxPurgeSdk = {
        files: {
          async list() {
            return [{ id: "f1" }].values();
          },
          async delete(fileId: string) {
            attempted.push(`file:${fileId}`);
          },
        },
        stt: {
          async list() {
            return [{ notAnId: true }].values() as unknown as AsyncIterable<{ id: string }>;
          },
          async delete(id: string) {
            attempted.push(`transcription:${id}`);
          },
        },
      };

      const report = await runSonioxPurge({ sdk, mode: "apply" });

      // A job we could not read may still reference f1's audio, so the file
      // sweep is unsafe even though no delete was attempted.
      assert.deepEqual(attempted, []);
      assert.equal(report.fileCount, 1);
      assert.equal(report.deletedFileCount, 0);
      assert.equal(report.outcome, "failed");
    });

    it("is idempotent: a second apply finds nothing left to delete", async () => {
      const files = new Set(["f1", "f2"]);
      const transcriptions = new Set(["t1"]);
      const sdk: SonioxPurgeSdk = {
        files: {
          async list() {
            return [...files].map((id) => ({ id })).values();
          },
          async delete(fileId: string) {
            if (!files.delete(fileId)) {
              throw new Error("already gone");
            }
          },
        },
        stt: {
          async list() {
            return [...transcriptions].map((id) => ({ id })).values();
          },
          async delete(id: string) {
            if (!transcriptions.delete(id)) {
              throw new Error("already gone");
            }
          },
        },
      };

      const first = await runSonioxPurge({ sdk, mode: "apply" });
      assert.equal(first.outcome, "completed");
      assert.equal(first.deletedTranscriptionCount, 1);
      assert.equal(first.deletedFileCount, 2);

      const second = await runSonioxPurge({ sdk, mode: "apply" });

      // A rerun after a completed sweep must not double-delete or fail.
      assert.deepEqual(second, {
        mode: "apply",
        outcome: "completed",
        fileCount: 0,
        transcriptionCount: 0,
        deletedFileCount: 0,
        deletedTranscriptionCount: 0,
      });
    });

    it("completes every transcription delete before any file delete", async () => {
      // Guards the phase ordering across batch boundaries: concurrency is
      // bounded within a phase, never across the job/file split.
      const order: string[] = [];
      const items = Array.from({ length: 12 }, (_, index) => ({ id: `x${index}` }));
      const sdk: SonioxPurgeSdk = {
        files: {
          async list() {
            return items.values();
          },
          async delete() {
            order.push("file");
          },
        },
        stt: {
          async list() {
            return items.values();
          },
          async delete() {
            order.push("transcription");
          },
        },
      };

      const report = await runSonioxPurge({ sdk, mode: "apply" });

      assert.equal(report.deletedTranscriptionCount, 12);
      assert.equal(report.deletedFileCount, 12);
      assert.ok(order.lastIndexOf("transcription") < order.indexOf("file"));
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

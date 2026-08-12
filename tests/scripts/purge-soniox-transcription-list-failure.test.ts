import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSonioxPurge, type SonioxPurgeSdk } from "../../src/scripts/purge-soniox-transcription.js";

async function* listItems(ids: readonly string[]): AsyncGenerator<{ id: string }> {
  for (const id of ids) {
    yield { id };
  }
}

async function* listThenFail(ids: readonly string[]): AsyncGenerator<{ id: string }> {
  yield* listItems(ids);
  throw new Error("list failed after yielding items");
}

describe("Soniox purge listing failures", () => {
  it("deletes a partial transcription batch before holding back files", async () => {
    const attempted: string[] = [];
    const sdk: SonioxPurgeSdk = {
      files: {
        async list() {
          return listItems(["f1"]);
        },
        async delete(fileId: string) {
          attempted.push(`file:${fileId}`);
        },
      },
      stt: {
        async list() {
          return listThenFail(["t1", "t2"]);
        },
        async delete(id: string) {
          attempted.push(`transcription:${id}`);
        },
      },
    };

    const report = await runSonioxPurge({ sdk, mode: "apply" });

    assert.deepEqual(attempted, ["transcription:t1", "transcription:t2"]);
    assert.equal(report.transcriptionCount, 2);
    assert.equal(report.deletedTranscriptionCount, 2);
    assert.equal(report.fileCount, 1);
    assert.equal(report.deletedFileCount, 0);
    assert.equal(report.outcome, "failed");
  });

  it("deletes a partial file batch after a successful transcription sweep", async () => {
    const attempted: string[] = [];
    const sdk: SonioxPurgeSdk = {
      files: {
        async list() {
          return listThenFail(["f1", "f2"]);
        },
        async delete(fileId: string) {
          attempted.push(`file:${fileId}`);
        },
      },
      stt: {
        async list() {
          return listItems([]);
        },
        async delete(id: string) {
          attempted.push(`transcription:${id}`);
        },
      },
    };

    const report = await runSonioxPurge({ sdk, mode: "apply" });

    assert.deepEqual(attempted, ["file:f1", "file:f2"]);
    assert.equal(report.fileCount, 2);
    assert.equal(report.deletedFileCount, 2);
    assert.equal(report.outcome, "failed");
  });
});

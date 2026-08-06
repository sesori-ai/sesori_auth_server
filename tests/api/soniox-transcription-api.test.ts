import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseTranscription,
  parseTranscriptText,
  parseUploadedFileId,
  toBillableSeconds,
  toFailureReason,
} from "../../src/api/soniox-transcription-api.js";
import { TranscriptionFailure, TranscriptionFailureReason } from "../../src/types/transcription.js";

function expectReason(run: () => unknown, reason: TranscriptionFailureReason): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof TranscriptionFailure);
    assert.equal(error.reason, reason);
    return true;
  });
}

describe("soniox transcription api", () => {
  describe("parseUploadedFileId", () => {
    it("accepts a valid file and returns only the id", () => {
      assert.equal(parseUploadedFileId({ id: "file_123", filename: "x.m4a" }), "file_123");
    });

    it("rejects a missing or malformed id as malformed output", () => {
      for (const value of [{}, { id: "" }, { id: 42 }, null, "file_123"]) {
        expectReason(() => parseUploadedFileId(value), TranscriptionFailureReason.MalformedOutput);
      }
    });
  });

  describe("parseTranscription", () => {
    it("accepts a completed transcription and normalizes an absent duration", () => {
      assert.deepEqual(parseTranscription({ id: "t1", status: "completed" }), {
        id: "t1",
        status: "completed",
        audioDurationMs: null,
      });
      assert.deepEqual(parseTranscription({ id: "t1", status: "completed", audio_duration_ms: 1500 }), {
        id: "t1",
        status: "completed",
        audioDurationMs: 1500,
      });
    });

    it("maps a provider error status to provider_rejected, not malformed output", () => {
      expectReason(
        () => parseTranscription({ id: "t1", status: "error", error_type: "bad_audio" }),
        TranscriptionFailureReason.ProviderRejected,
      );
    });

    it("treats an unfinished status as a timeout", () => {
      for (const status of ["queued", "processing"]) {
        expectReason(() => parseTranscription({ id: "t1", status }), TranscriptionFailureReason.Timeout);
      }
    });

    it("rejects unknown statuses and malformed durations", () => {
      for (const value of [
        { id: "t1", status: "unknown_status" },
        { id: "t1", status: "completed", audio_duration_ms: -1 },
        { id: "t1", status: "completed", audio_duration_ms: Number.NaN },
        { id: "", status: "completed" },
      ]) {
        expectReason(() => parseTranscription(value), TranscriptionFailureReason.MalformedOutput);
      }
    });
  });

  describe("parseTranscriptText", () => {
    it("accepts text including empty text", () => {
      assert.equal(parseTranscriptText({ text: "hello" }), "hello");
      assert.equal(parseTranscriptText({ text: "" }), "");
    });

    it("rejects a missing or non-string text", () => {
      for (const value of [{}, { text: 42 }, null]) {
        expectReason(() => parseTranscriptText(value), TranscriptionFailureReason.MalformedOutput);
      }
    });
  });

  describe("toBillableSeconds", () => {
    it("rounds a partial second up so it is never billed as zero", () => {
      assert.equal(toBillableSeconds(1), 1);
      assert.equal(toBillableSeconds(1500), 2);
      assert.equal(toBillableSeconds(2000), 2);
      assert.equal(toBillableSeconds(0), 0);
    });

    it("treats an absent duration as malformed rather than free", () => {
      expectReason(() => toBillableSeconds(null), TranscriptionFailureReason.MalformedOutput);
    });
  });

  describe("toFailureReason", () => {
    it("passes an existing failure through unchanged", () => {
      const failure = new TranscriptionFailure(TranscriptionFailureReason.Capacity);
      assert.equal(toFailureReason(failure), TranscriptionFailureReason.Capacity);
    });

    it("maps the abort shapes the SDK actually emits", () => {
      // Real shape: the SDK normalizes fetch aborts into SonioxHttpError with
      // code "aborted" and no statusCode. A DOM-style AbortError never appears.
      const sdkHttpAbort = Object.assign(new Error("Request was aborted"), {
        name: "SonioxHttpError",
        code: "aborted",
      });
      assert.equal(toFailureReason(sdkHttpAbort), TranscriptionFailureReason.Cancelled);

      // Real shape: the polling loop throws a bare Error with this exact message.
      assert.equal(toFailureReason(new Error("Transcription wait aborted")), TranscriptionFailureReason.Cancelled);

      // DOM-style shapes remain supported for non-SDK callers.
      const domAbort = new Error("aborted");
      domAbort.name = "AbortError";
      assert.equal(toFailureReason(domAbort), TranscriptionFailureReason.Cancelled);

      const timeout = new Error("timed out");
      timeout.name = "TimeoutError";
      assert.equal(toFailureReason(timeout), TranscriptionFailureReason.Timeout);
    });

    it("maps HTTP status codes to provider-neutral reasons", () => {
      const cases: [number, TranscriptionFailureReason][] = [
        [429, TranscriptionFailureReason.Capacity],
        [400, TranscriptionFailureReason.InvalidInput],
        [413, TranscriptionFailureReason.InvalidInput],
        [415, TranscriptionFailureReason.InvalidInput],
        [422, TranscriptionFailureReason.InvalidInput],
        [401, TranscriptionFailureReason.ProviderRejected],
        [403, TranscriptionFailureReason.ProviderRejected],
        [404, TranscriptionFailureReason.ProviderRejected],
        [500, TranscriptionFailureReason.Unavailable],
        [503, TranscriptionFailureReason.Unavailable],
        [418, TranscriptionFailureReason.Internal],
      ];

      for (const [statusCode, expected] of cases) {
        assert.equal(toFailureReason(Object.assign(new Error("x"), { statusCode })), expected, String(statusCode));
      }
    });

    it("treats an unrecognized error as unavailable rather than leaking it", () => {
      assert.equal(toFailureReason(new Error("network down")), TranscriptionFailureReason.Unavailable);
      assert.equal(toFailureReason("string failure"), TranscriptionFailureReason.Unavailable);
    });
  });
});

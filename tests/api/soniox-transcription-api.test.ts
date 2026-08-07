import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCreatedTranscriptionId,
  parseTranscription,
  parseTranscriptText,
  parseUploadedFileId,
  readProviderRetryAfterSeconds,
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
    it("accepts a completed transcription carrying a billable duration", () => {
      assert.deepEqual(parseTranscription({ id: "t1", status: "completed", audio_duration_ms: 1500 }, "t1"), {
        id: "t1",
        status: "completed",
        audioDurationMs: 1500,
      });
    });

    it("rejects a record naming a different job than the one we created", () => {
      // Without this the caller would fetch and bill another job's transcript
      // while cleanup deleted ours.
      expectReason(
        () => parseTranscription({ id: "someone_elses_job", status: "completed", audio_duration_ms: 1500 }, "t1"),
        TranscriptionFailureReason.MalformedOutput,
      );
    });

    it("rejects a completed transcription with no duration at the boundary", () => {
      for (const value of [
        { id: "t1", status: "completed" },
        { id: "t1", status: "completed", audio_duration_ms: null },
      ]) {
        expectReason(() => parseTranscription(value, "t1"), TranscriptionFailureReason.MalformedOutput);
      }
    });

    it("maps a provider error status to a rejection, not malformed output", () => {
      expectReason(
        () => parseTranscription({ id: "t1", status: "error", error_type: "unauthorized" }, "t1"),
        TranscriptionFailureReason.ProviderRejected,
      );
    });

    it("treats an unfinished status as a timeout", () => {
      for (const status of ["queued", "processing"]) {
        expectReason(() => parseTranscription({ id: "t1", status }, "t1"), TranscriptionFailureReason.Timeout);
      }
    });

    it("classifies an audio rejection as caller input, not a configuration fault", () => {
      for (const errorType of ["bad_audio", "unsupported_audio", "audio_too_short"]) {
        expectReason(
          () => parseTranscription({ id: "t1", status: "error", error_type: errorType }, "t1"),
          TranscriptionFailureReason.InvalidInput,
        );
      }
    });

    it("keeps an unknown or credential-style error as a configuration fault", () => {
      for (const errorType of ["unauthorized", "internal", null, undefined]) {
        expectReason(
          () => parseTranscription({ id: "t1", status: "error", error_type: errorType }, "t1"),
          TranscriptionFailureReason.ProviderRejected,
        );
      }
    });

    it("classifies a failed job by its error type even when it echoes a bad duration", () => {
      // The duration bound must not short-circuit the error classification: a
      // failed job's duration is meaningless.
      expectReason(
        () => parseTranscription({ id: "t1", status: "error", error_type: "bad_audio", audio_duration_ms: 0 }, "t1"),
        TranscriptionFailureReason.InvalidInput,
      );
      expectReason(
        () =>
          parseTranscription({ id: "t1", status: "error", error_type: "unauthorized", audio_duration_ms: -5 }, "t1"),
        TranscriptionFailureReason.ProviderRejected,
      );
    });

    it("rejects a non-positive or absurd duration rather than billing it", () => {
      for (const audioDurationMs of [0, -1, 86_400_001]) {
        expectReason(
          () => parseTranscription({ id: "t1", status: "completed", audio_duration_ms: audioDurationMs }, "t1"),
          TranscriptionFailureReason.MalformedOutput,
        );
      }
    });

    it("bounds duration on an exclusive 24h limit at the exact boundary", () => {
      assert.equal(
        parseTranscription({ id: "t1", status: "completed", audio_duration_ms: 86_399_999 }, "t1").audioDurationMs,
        86_399_999,
      );

      // Exactly 24h is out of contract, so equality must reject rather than bill.
      expectReason(
        () => parseTranscription({ id: "t1", status: "completed", audio_duration_ms: 86_400_000 }, "t1"),
        TranscriptionFailureReason.MalformedOutput,
      );
    });

    it("rejects unknown statuses and malformed durations", () => {
      for (const value of [
        { id: "t1", status: "unknown_status" },
        { id: "t1", status: "completed", audio_duration_ms: Number.NaN },
        { id: "", status: "completed" },
      ]) {
        expectReason(() => parseTranscription(value, "t1"), TranscriptionFailureReason.MalformedOutput);
      }
    });
  });

  describe("parseCreatedTranscriptionId", () => {
    it("accepts a non-terminal job, which is what creation actually returns", () => {
      for (const status of ["queued", "processing"]) {
        assert.equal(parseCreatedTranscriptionId({ id: "tr_1", status }), "tr_1");
      }
    });

    it("rejects a missing or empty id", () => {
      for (const value of [{}, { id: "" }, { id: 7 }, null]) {
        expectReason(() => parseCreatedTranscriptionId(value), TranscriptionFailureReason.MalformedOutput);
      }
    });
  });

  describe("parseTranscriptText", () => {
    it("accepts usable text", () => {
      assert.equal(parseTranscriptText({ text: "hello" }), "hello");
    });

    it("rejects empty or whitespace-only text before it can be billed", () => {
      for (const text of ["", "   ", "\n\t "]) {
        expectReason(() => parseTranscriptText({ text }), TranscriptionFailureReason.MalformedOutput);
      }
    });

    it("rejects an oversized transcript", () => {
      expectReason(
        () => parseTranscriptText({ text: "x".repeat(1_000_001) }),
        TranscriptionFailureReason.MalformedOutput,
      );
    });

    it("bounds transcript length inclusively at the exact limit", () => {
      assert.equal(parseTranscriptText({ text: "x".repeat(1_000_000) }).length, 1_000_000);

      expectReason(
        () => parseTranscriptText({ text: "x".repeat(1_000_001) }),
        TranscriptionFailureReason.MalformedOutput,
      );
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
    });

    it("treats an absent or non-positive duration as malformed rather than free", () => {
      for (const value of [null, 0, -1]) {
        expectReason(() => toBillableSeconds(value), TranscriptionFailureReason.MalformedOutput);
      }
    });
  });

  describe("toFailureReason", () => {
    it("passes an existing failure through unchanged", () => {
      const failure = new TranscriptionFailure(TranscriptionFailureReason.Capacity);
      assert.equal(toFailureReason(failure), TranscriptionFailureReason.Capacity);
    });

    it("never reports an abort shape as cancelled, because it does not own that decision", () => {
      // Cancellation and budget expiry are decided by the client from the
      // signals it owns. An abort reaching this function means neither fired,
      // so it is an unexplained transport abort, not a caller request.
      const sdkHttpAbort = Object.assign(new Error("Request was aborted"), {
        name: "SonioxHttpError",
        code: "aborted",
      });
      assert.equal(toFailureReason(sdkHttpAbort), TranscriptionFailureReason.Unavailable);

      // Real shape: the polling loop throws a bare Error with this exact message.
      assert.equal(toFailureReason(new Error("Transcription wait aborted")), TranscriptionFailureReason.Unavailable);

      const domAbort = new Error("aborted");
      domAbort.name = "AbortError";
      assert.equal(toFailureReason(domAbort), TranscriptionFailureReason.Unavailable);

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

  describe("readProviderRetryAfterSeconds", () => {
    it("recovers the cooldown a rate-limited provider asked for", () => {
      // The SDK keeps response headers on SonioxHttpError, so a 429 cooldown is
      // recoverable; discarding it would retry into an active rate limit.
      const rateLimited = Object.assign(new Error("HTTP 429"), {
        name: "SonioxHttpError",
        statusCode: 429,
        headers: { "retry-after": "60" },
      });

      assert.equal(readProviderRetryAfterSeconds(rateLimited), 60);
    });

    it("ignores the HTTP-date form rather than trusting a provider clock", () => {
      const dated = Object.assign(new Error("HTTP 429"), {
        headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
      });

      assert.equal(readProviderRetryAfterSeconds(dated), undefined);
    });

    it("returns undefined when no usable cooldown is present", () => {
      for (const error of [
        new Error("no headers"),
        Object.assign(new Error("x"), { headers: {} }),
        Object.assign(new Error("x"), { headers: { "retry-after": "0" } }),
        Object.assign(new Error("x"), { headers: { "retry-after": "-5" } }),
        Object.assign(new Error("x"), { headers: { "retry-after": "1.5" } }),
        Object.assign(new Error("x"), { headers: { "retry-after": "" } }),
        Object.assign(new Error("x"), { headers: null }),
        "not an object",
      ]) {
        assert.equal(readProviderRetryAfterSeconds(error), undefined);
      }
    });
  });
});

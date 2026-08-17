import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSonioxRealtimeError,
  parseSonioxRealtimeResult,
  toRealtimeFailureReason,
} from "../../src/api/soniox-realtime-api.js";
import { MAX_REALTIME_TRANSCRIPT_CHARACTERS } from "../../src/models/voice.js";
import { isPublicEventValid } from "../../src/services/realtime-transcription-events.js";
import {
  RealtimeProviderEventType,
  RealtimeServerEventType,
  RealtimeTranscriptionFailure,
  RealtimeTranscriptionFailureReason,
} from "../../src/types/transcription.js";

function expectReason(run: () => unknown, reason: RealtimeTranscriptionFailureReason): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RealtimeTranscriptionFailure);
    assert.equal(error.reason, reason);
    return true;
  });
}

describe("soniox realtime api boundary", () => {
  it("normalizes final and provisional tokens without provider metadata", () => {
    const event = parseSonioxRealtimeResult(
      {
        tokens: [
          { text: "hello ", confidence: 0.9, is_final: true, speaker: "s1" },
          { text: "world", confidence: 0.4, is_final: false, language: "en" },
        ],
        final_audio_proc_ms: 120,
        total_audio_proc_ms: 180,
      },
      { maxAudioDurationMs: 1_000 },
    );

    assert.deepEqual(event, {
      type: "transcript",
      confirmedDelta: "hello ",
      provisional: "world",
      finalAudioMs: 120,
      totalAudioMs: 180,
    });
  });

  it("keeps Soniox control tokens out of transcript text", () => {
    assert.deepEqual(
      parseSonioxRealtimeResult(
        {
          tokens: [
            { text: "<end>", confidence: 1, is_final: true },
            { text: "ok", confidence: 1, is_final: true },
            { text: "<fin>", confidence: 1, is_final: true },
          ],
          final_audio_proc_ms: 1,
          total_audio_proc_ms: 1,
        },
        { maxAudioDurationMs: 1_000 },
      ),
      { type: "transcript", confirmedDelta: "ok", provisional: "", finalAudioMs: 1, totalAudioMs: 1 },
    );

    assert.deepEqual(
      parseSonioxRealtimeResult(
        {
          tokens: [{ text: "<fin>", confidence: 1, is_final: true }],
          final_audio_proc_ms: 1,
          total_audio_proc_ms: 1,
          finished: true,
        },
        { maxAudioDurationMs: 1_000 },
      ),
      { type: "finished" },
    );
  });

  it("accepts separate public transcript fields up to the schema max", () => {
    const event = parseSonioxRealtimeResult(
      {
        tokens: [
          { text: "x".repeat(20_000), confidence: 1, is_final: true },
          { text: "y".repeat(20_000), confidence: 1, is_final: false },
        ],
        final_audio_proc_ms: 1,
        total_audio_proc_ms: 1,
      },
      { maxAudioDurationMs: 1_000 },
    );

    assert.equal(event.type, "transcript");
    assert.equal(event.confirmedDelta.length, 20_000);
    assert.equal(event.provisional.length, 20_000);
  });

  it("bounds assembled transcript fields individually to the schema max instead of failing", () => {
    const overConfirmed = parseSonioxRealtimeResult(
      {
        tokens: [
          { text: "x".repeat(32_769), confidence: 1, is_final: true },
          { text: "y", confidence: 1, is_final: false },
        ],
        final_audio_proc_ms: 1,
        total_audio_proc_ms: 1,
      },
      { maxAudioDurationMs: 1_000 },
    );

    assert.equal(overConfirmed.type, "transcript");
    assert.equal(overConfirmed.confirmedDelta.length, MAX_REALTIME_TRANSCRIPT_CHARACTERS);
    assert.equal(overConfirmed.provisional, "y");

    const overProvisional = parseSonioxRealtimeResult(
      {
        tokens: [
          { text: "x", confidence: 1, is_final: true },
          { text: "y".repeat(32_769), confidence: 1, is_final: false },
        ],
        final_audio_proc_ms: 1,
        total_audio_proc_ms: 1,
      },
      { maxAudioDurationMs: 1_000 },
    );

    assert.equal(overProvisional.type, "transcript");
    assert.equal(overProvisional.confirmedDelta, "x");
    assert.equal(overProvisional.provisional.length, MAX_REALTIME_TRANSCRIPT_CHARACTERS);
  });

  /**
   * CQ-8/PF-5 regression. The parser used to admit two full-width fields and a
   * single multi-byte field of the same character length, both of which the
   * public emitter then rejected on serialized size — and the session
   * controller turned that rejection into an `internal_error` terminal. Every
   * transcript this boundary produces must now be emittable.
   */
  for (const [name, tokens] of [
    [
      "two ASCII fields at the character cap",
      [
        { text: "x".repeat(32_768), confidence: 1, is_final: true },
        { text: "y".repeat(32_768), confidence: 1, is_final: false },
      ],
    ],
    [
      "one two-byte-per-code-point field at the character cap",
      [{ text: "д".repeat(32_768), confidence: 1, is_final: true }],
    ],
    [
      "one field of characters JSON escapes to six bytes each",
      [{ text: "\u0001".repeat(32_768), confidence: 1, is_final: true }],
    ],
    [
      "one field of astral code points at the character cap",
      [{ text: "😀".repeat(16_384), confidence: 1, is_final: true }],
    ],
  ] as const) {
    it(`keeps ${name} emittable rather than terminating the session`, () => {
      const event = parseSonioxRealtimeResult(
        { tokens, final_audio_proc_ms: 1, total_audio_proc_ms: 1 },
        { maxAudioDurationMs: 1_000 },
      );

      assert.equal(event.type, RealtimeProviderEventType.Transcript);
      assert.ok(event.type === RealtimeProviderEventType.Transcript);
      assert.ok(event.confirmedDelta.length > 0 || event.provisional.length > 0);
      // Never a lone surrogate: bounding must cut on code-point boundaries.
      assert.equal(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(event.confirmedDelta),
        false,
      );
      assert.equal(
        isPublicEventValid({
          type: RealtimeServerEventType.Transcript,
          confirmedDelta: event.confirmedDelta,
          provisional: event.provisional,
        }),
        true,
      );
    });
  }

  it("rejects provider-reported durations beyond the session contract", () => {
    expectReason(
      () =>
        parseSonioxRealtimeResult(
          { tokens: [], final_audio_proc_ms: 1_001, total_audio_proc_ms: 1 },
          { maxAudioDurationMs: 1_000 },
        ),
      RealtimeTranscriptionFailureReason.MalformedOutput,
    );
  });

  it("accepts the provider echo field the SDK always emits without propagating it", () => {
    // @soniox/node's parseResultMessage returns `raw` unconditionally and
    // handleMessage spreads it into every emitted result. Rejecting it would
    // fail the first transcript of every session. It carries the untrimmed
    // provider payload, so it must be accepted and then dropped, never echoed.
    const event = parseSonioxRealtimeResult(
      {
        tokens: [{ text: "hello", confidence: 0.9, is_final: true }],
        final_audio_proc_ms: 10,
        total_audio_proc_ms: 20,
        finished: false,
        raw: { tokens: [{ text: "hello", speaker: "s1" }], secret_provider_field: "must not surface" },
      },
      { maxAudioDurationMs: 1_000 },
    );

    assert.deepEqual(event, {
      type: RealtimeProviderEventType.Transcript,
      confirmedDelta: "hello",
      provisional: "",
      finalAudioMs: 10,
      totalAudioMs: 20,
    });
    assert.ok(!JSON.stringify(event).includes("secret_provider_field"));
  });

  it("rejects malformed or unknown Soniox result fields", () => {
    for (const value of [
      // `raw` is deliberately absent here: the SDK emits it on every result, so
      // it is accepted and dropped (covered above). Any OTHER unknown key must
      // still fail, which is what keeps `.strict()` load-bearing.
      { tokens: [], final_audio_proc_ms: 0, total_audio_proc_ms: 0, unexpected_provider_field: "x" },
      {
        tokens: [{ text: "x", confidence: 0, is_final: false, extra: true }],
        final_audio_proc_ms: 0,
        total_audio_proc_ms: 0,
      },
      { tokens: [], final_audio_proc_ms: -1, total_audio_proc_ms: 0 },
    ]) {
      expectReason(
        () => parseSonioxRealtimeResult(value, { maxAudioDurationMs: 1_000 }),
        RealtimeTranscriptionFailureReason.MalformedOutput,
      );
    }
  });

  it("maps provider error payloads and thrown SDK errors without raw messages", () => {
    expectReason(
      () => parseSonioxRealtimeError({ error_code: 401, error_message: "secret token bad" }),
      RealtimeTranscriptionFailureReason.Configuration,
    );
    expectReason(
      () => parseSonioxRealtimeError({ error_code: 429, error_message: "quota text" }),
      RealtimeTranscriptionFailureReason.Capacity,
    );

    assert.equal(
      toRealtimeFailureReason(Object.assign(new Error("raw"), { code: "aborted" })),
      RealtimeTranscriptionFailureReason.Unavailable,
    );
  });
});

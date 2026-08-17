import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSonioxRealtimeError,
  parseSonioxRealtimeResult,
  toRealtimeFailureReason,
} from "../../src/api/soniox-realtime-api.js";
import {
  RealtimeProviderEventType,
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

  it("rejects assembled transcript fields individually beyond the schema max", () => {
    expectReason(
      () =>
        parseSonioxRealtimeResult(
          {
            tokens: [
              { text: "x".repeat(32_769), confidence: 1, is_final: true },
              { text: "y", confidence: 1, is_final: false },
            ],
            final_audio_proc_ms: 1,
            total_audio_proc_ms: 1,
          },
          { maxAudioDurationMs: 1_000 },
        ),
      RealtimeTranscriptionFailureReason.MalformedOutput,
    );
    expectReason(
      () =>
        parseSonioxRealtimeResult(
          {
            tokens: [
              { text: "x", confidence: 1, is_final: true },
              { text: "y".repeat(32_769), confidence: 1, is_final: false },
            ],
            final_audio_proc_ms: 1,
            total_audio_proc_ms: 1,
          },
          { maxAudioDurationMs: 1_000 },
        ),
      RealtimeTranscriptionFailureReason.MalformedOutput,
    );
  });

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

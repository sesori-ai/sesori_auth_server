import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exceedsRealtimePace } from "../../src/services/realtime-audio-accounting.js";
import { RealtimeSampleRate } from "../../src/types/transcription.js";

const PCM_16K_MONO = { sampleRate: RealtimeSampleRate.Rate16000, channels: 1 } as const;

/**
 * 16 kHz mono s16le is 32 000 bytes per second, so one elapsed millisecond is worth exactly
 * 32 bytes and a one-second burst allowance exactly 32 000. Every expectation below is that
 * exact integer count, which is the point: the allowance used to be derived through a seconds
 * value, and `1 / 1000 + 1` is not exactly 1.001 in binary floating point, so the allowance
 * landed a fraction below 32 032 and `Math.floor` rounded a client that fit precisely into a
 * client that had overrun. A frame is refused only when it is genuinely over the line.
 */
describe("exceedsRealtimePace", () => {
  it("accepts a frame that exactly fills the allowance and refuses the next byte", () => {
    const atBoundary = exceedsRealtimePace({
      ...PCM_16K_MONO,
      byteLength: 32_032,
      attemptedBytes: 0,
      elapsedMs: 1,
      burstSeconds: 1,
    });
    const oneByteOver = exceedsRealtimePace({
      ...PCM_16K_MONO,
      byteLength: 32_033,
      attemptedBytes: 0,
      elapsedMs: 1,
      burstSeconds: 1,
    });

    assert.equal(atBoundary, false);
    assert.equal(oneByteOver, true);
  });

  it("measures the boundary cumulatively across earlier frames", () => {
    const atBoundary = exceedsRealtimePace({
      ...PCM_16K_MONO,
      byteLength: 32,
      attemptedBytes: 32_000,
      elapsedMs: 1,
      burstSeconds: 1,
    });
    const oneByteOver = exceedsRealtimePace({
      ...PCM_16K_MONO,
      byteLength: 33,
      attemptedBytes: 32_000,
      elapsedMs: 1,
      burstSeconds: 1,
    });

    assert.equal(atBoundary, false);
    assert.equal(oneByteOver, true);
  });

  it("credits elapsed time without a burst allowance and refuses the next byte", () => {
    const atBoundary = exceedsRealtimePace({
      ...PCM_16K_MONO,
      byteLength: 92_800,
      attemptedBytes: 0,
      elapsedMs: 2_900,
      burstSeconds: 0,
    });
    const oneByteOver = exceedsRealtimePace({
      ...PCM_16K_MONO,
      byteLength: 92_801,
      attemptedBytes: 0,
      elapsedMs: 2_900,
      burstSeconds: 0,
    });

    assert.equal(atBoundary, false);
    assert.equal(oneByteOver, true);
  });

  // A clock that steps backwards must not hand out credit for negative elapsed time; the burst
  // allowance alone is the floor.
  it("credits no elapsed time when the session clock goes backwards", () => {
    const atBurstAllowance = exceedsRealtimePace({
      ...PCM_16K_MONO,
      byteLength: 32_000,
      attemptedBytes: 0,
      elapsedMs: -50,
      burstSeconds: 1,
    });
    const oneByteOver = exceedsRealtimePace({
      ...PCM_16K_MONO,
      byteLength: 32_001,
      attemptedBytes: 0,
      elapsedMs: -50,
      burstSeconds: 1,
    });

    assert.equal(atBurstAllowance, false);
    assert.equal(oneByteOver, true);
  });

  it("holds the boundary exactly at every supported sample rate", () => {
    for (const sampleRate of [
      RealtimeSampleRate.Rate16000,
      RealtimeSampleRate.Rate24000,
      RealtimeSampleRate.Rate44100,
      RealtimeSampleRate.Rate48000,
    ]) {
      for (const channels of [1, 2]) {
        const bytesPerSecond = sampleRate * channels * 2;
        // The allowance is whole bytes of elapsed credit plus the whole-second burst. 10 ms is
        // chosen because the discarded seconds-based arithmetic lost a byte here at every one of
        // these rates, so this case fails if that arithmetic ever comes back.
        const allowedBytes = Math.floor((10 * bytesPerSecond) / 1000) + 2 * bytesPerSecond;
        const shared = { sampleRate, channels, attemptedBytes: 0, elapsedMs: 10, burstSeconds: 2 };

        assert.equal(exceedsRealtimePace({ ...shared, byteLength: allowedBytes }), false);
        assert.equal(exceedsRealtimePace({ ...shared, byteLength: allowedBytes + 1 }), true);
      }
    }
  });
});

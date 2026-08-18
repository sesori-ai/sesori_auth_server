const BYTES_PER_SAMPLE = 2;

export type PcmAccountingInput = {
  readonly byteLength: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly attemptedBytes: number;
  readonly limitSeconds: number;
};

export function isAlignedPcm(input: { readonly byteLength: number; readonly channels: number }): boolean {
  const sampleBytes = input.channels * BYTES_PER_SAMPLE;
  return input.byteLength > 0 && input.byteLength % BYTES_PER_SAMPLE === 0 && input.byteLength % sampleBytes === 0;
}

export function acceptedFrameBytes(input: PcmAccountingInput): number {
  const capBytes = Math.floor(input.limitSeconds * bytesPerSecond(input));
  const acceptedBytes = Math.min(input.byteLength, Math.max(0, capBytes - input.attemptedBytes));
  return acceptedBytes - (acceptedBytes % (input.channels * BYTES_PER_SAMPLE));
}

export function reachedAudioLimit(input: Omit<PcmAccountingInput, "byteLength">): boolean {
  return input.attemptedBytes >= Math.floor(input.limitSeconds * bytesPerSecond(input));
}

/**
 * True when accepting this frame would put the session further ahead of real time than the burst
 * allowance permits. Live capture yields one second of audio per elapsed second, so a client that
 * buffers during a network stall stays within budget: the stall advances the elapsed clock by the
 * same amount it buffered.
 */
export function exceedsRealtimePace(input: {
  readonly byteLength: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly attemptedBytes: number;
  readonly elapsedMs: number;
  readonly burstSeconds: number;
}): boolean {
  // The allowance is computed in whole bytes rather than via an intermediate seconds value.
  // `elapsedMs / 1000` is not exactly representable in binary floating point, so scaling that
  // quotient by the byte rate landed a hair below the byte count the elapsed time is actually
  // worth, and `Math.floor` then turned that hair into a whole byte: a frame that exactly fits
  // the allowance was rejected as if it had overrun it. Multiplying first keeps every
  // intermediate an exact integer at these magnitudes, and `burstSeconds` is a whole number of
  // seconds by config, so its contribution is exact too.
  const bytesPerSecondValue = bytesPerSecond(input);
  const allowedBytes =
    Math.floor((Math.max(0, input.elapsedMs) * bytesPerSecondValue) / 1000) + input.burstSeconds * bytesPerSecondValue;
  return input.attemptedBytes + input.byteLength > allowedBytes;
}

export function billableSeconds(input: {
  readonly attemptedBytes: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly providerProgressMs: number;
}): number {
  const acceptedMs = (input.attemptedBytes / bytesPerSecond(input)) * 1000;
  return Math.ceil(Math.max(acceptedMs, input.providerProgressMs) / 1000);
}

function bytesPerSecond(input: { readonly sampleRate: number; readonly channels: number }): number {
  return input.sampleRate * input.channels * BYTES_PER_SAMPLE;
}

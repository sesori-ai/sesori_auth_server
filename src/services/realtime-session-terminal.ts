import {
  RealtimeFinishedReason,
  RealtimeProtocolErrorCode,
  RealtimeTranscriptionFailure,
  RealtimeTranscriptionFailureReason,
} from "../types/transcription.js";
import type { RealtimeTranscriptionSession as ProviderSession } from "../clients/realtime-transcription-client.js";
import type { RealtimeStartRequest } from "./realtime-transcription-contracts.js";
import { acceptedFrameBytes, billableSeconds, isAlignedPcm, reachedAudioLimit } from "./realtime-audio-accounting.js";
import { emitReadyEvent } from "./realtime-public-event-emitter.js";
import { RealtimeAdmissionError, toProviderErrorCode } from "./realtime-transcription-errors.js";
import { withTimeout } from "./realtime-session-utils.js";

export type TerminalDecision =
  | { readonly kind: "complete"; readonly reason: RealtimeFinishedReason }
  | { readonly kind: "silent" }
  | { readonly kind: "error"; readonly code: RealtimeProtocolErrorCode; readonly recordUsage?: boolean };

export type RealtimeAudioFrameResult =
  | { readonly kind: "sent"; readonly attemptedBytes: number; readonly reachedLimit: boolean }
  | { readonly kind: "limit" }
  | { readonly kind: "invalid" }
  | { readonly kind: "error"; readonly code: RealtimeProtocolErrorCode };

export function toProviderTimeoutCode(error: unknown): RealtimeProtocolErrorCode {
  if (error instanceof Error && error.message === "finish_timeout") {
    return RealtimeProtocolErrorCode.ProviderTimeout;
  }

  return toProviderErrorCode(error);
}

export function forceCloseProvider(args: {
  readonly abortController: AbortController;
  readonly provider: ProviderSession | null;
  readonly resolveClosed: () => void;
}): void {
  args.abortController.abort();
  args.provider?.close();
  args.resolveClosed();
}

export function onProviderClosed(args: {
  readonly provider: ProviderSession;
  readonly isClosed: () => boolean;
  readonly beginTerminal: (decision: TerminalDecision) => void;
}): void {
  args.provider.closed.catch((error: unknown) => {
    if (!args.isClosed()) {
      args.beginTerminal(toProviderClosedTerminalDecision(error));
    }
  });
}

function toProviderClosedTerminalDecision(error: unknown): TerminalDecision {
  if (
    error instanceof RealtimeTranscriptionFailure &&
    error.reason === RealtimeTranscriptionFailureReason.MalformedOutput
  ) {
    return { kind: "error", code: RealtimeProtocolErrorCode.InternalError, recordUsage: false };
  }

  return { kind: "error", code: toProviderErrorCode(error) };
}

export function sendRealtimeAudioFrame(args: {
  readonly provider: ProviderSession | null;
  readonly request: RealtimeStartRequest;
  readonly data: Buffer;
  readonly attemptedBytes: number;
  readonly limitSeconds: number;
}): RealtimeAudioFrameResult {
  const { audio } = args.request;
  if (!isAlignedPcm({ byteLength: args.data.byteLength, channels: audio.channels })) {
    return { kind: "invalid" };
  }

  const alignedBytes = acceptedFrameBytes({
    byteLength: args.data.byteLength,
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    attemptedBytes: args.attemptedBytes,
    limitSeconds: args.limitSeconds,
  });
  if (alignedBytes <= 0) {
    return { kind: "limit" };
  }

  try {
    args.provider?.sendAudio(alignedBytes === args.data.byteLength ? args.data : args.data.subarray(0, alignedBytes));
  } catch (error) {
    return { kind: "error", code: toProviderErrorCode(error) };
  }

  const attemptedBytes = args.attemptedBytes + alignedBytes;
  return {
    kind: "sent",
    attemptedBytes,
    reachedLimit: reachedRealtimeAudioLimit({ request: args.request, attemptedBytes, limitSeconds: args.limitSeconds }),
  };
}

export function emitRealtimeReady(args: {
  readonly request: RealtimeStartRequest;
  readonly providerLimitSeconds: number;
  readonly remainingAtAdmission: number;
}): void {
  if (
    !emitReadyEvent({
      callbacks: args.request.callbacks,
      maxSessionSeconds: args.providerLimitSeconds,
      dailySecondsRemaining: args.remainingAtAdmission,
    })
  ) {
    throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.InternalError);
  }
}

export async function finishRealtimeProvider(args: {
  readonly provider: ProviderSession | null;
  readonly billableSeconds: number;
  readonly finishTimeoutMs: number;
  readonly completeWithoutProvider: () => Promise<void>;
  readonly fail: (code: RealtimeProtocolErrorCode) => Promise<void>;
}): Promise<void> {
  if (args.billableSeconds === 0) {
    args.provider?.cancel();
    await args.completeWithoutProvider();
    return;
  }

  try {
    await withTimeout(args.provider?.finish() ?? Promise.resolve(), args.finishTimeoutMs, "finish_timeout");
  } catch (error) {
    await args.fail(toProviderTimeoutCode(error));
  }
}

export function billableRealtimeSeconds(args: {
  readonly request: RealtimeStartRequest;
  readonly attemptedBytes: number;
  readonly providerProgressMs: number;
}): number {
  return billableSeconds({
    attemptedBytes: args.attemptedBytes,
    sampleRate: args.request.audio.sampleRate,
    channels: args.request.audio.channels,
    providerProgressMs: args.providerProgressMs,
  });
}

export function reachedRealtimeAudioLimit(args: {
  readonly request: RealtimeStartRequest;
  readonly attemptedBytes: number;
  readonly limitSeconds: number;
}): boolean {
  return reachedAudioLimit({
    sampleRate: args.request.audio.sampleRate,
    channels: args.request.audio.channels,
    attemptedBytes: args.attemptedBytes,
    limitSeconds: args.limitSeconds,
  });
}

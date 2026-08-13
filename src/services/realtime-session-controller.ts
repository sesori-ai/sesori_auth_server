import type {
  RealtimeProviderEvent,
  RealtimeTranscriptionClient,
  RealtimeTranscriptionSession as ProviderSession,
} from "../clients/realtime-transcription-client.js";
import type {
  RealtimeSessionOwner,
  RealtimeStartRequest,
  RealtimeTranscriptionPolicy,
  RealtimeTranscriptionSession,
} from "./realtime-transcription-contracts.js";
import { RealtimeAdmissionError } from "./realtime-transcription-errors.js";
import { emitTerminalEvent, emitTranscriptEvent } from "./realtime-public-event-emitter.js";
import { Deferred, RealtimeSessionTimers } from "./realtime-session-utils.js";
import { RealtimeFinishedReason, RealtimeProtocolErrorCode } from "../types/transcription.js";
import {
  billableRealtimeSeconds,
  emitRealtimeReady,
  finishRealtimeProvider,
  forceCloseProvider,
  onProviderClosed,
  sendRealtimeAudioFrame,
  type TerminalDecision,
} from "./realtime-session-terminal.js";

type SessionState = "streaming" | "finishing" | "closed";

export class RealtimeSessionController implements RealtimeTranscriptionSession {
  readonly #service: RealtimeSessionOwner;
  readonly #request: RealtimeStartRequest;
  readonly #policy: RealtimeTranscriptionPolicy;
  readonly #abortController = new AbortController();
  readonly #providerSignal: AbortSignal;
  readonly #closed = new Deferred<void>();
  readonly #timers = new RealtimeSessionTimers();
  #providerLimitSeconds: number;
  #remainingAtAdmission: number;
  #readyLimitReason: RealtimeFinishedReason;
  #provider: ProviderSession | null = null;
  #terminalPromise: Promise<void> | null = null;
  #finishPromise: Promise<void> | null = null;
  #finishReason: RealtimeFinishedReason = RealtimeFinishedReason.Finished;
  #state: SessionState = "streaming";
  #attemptedBytes = 0;
  #providerProgressMs = 0;

  constructor(args: {
    readonly service: RealtimeSessionOwner;
    readonly request: RealtimeStartRequest;
    readonly policy: RealtimeTranscriptionPolicy;
    readonly providerLimitSeconds: number;
    readonly readyLimitReason: RealtimeFinishedReason;
    readonly remainingAtAdmission: number;
  }) {
    this.#service = args.service;
    this.#request = args.request;
    this.#policy = args.policy;
    this.#providerSignal = AbortSignal.any([this.#abortController.signal, args.request.signal]);
    this.#providerLimitSeconds = args.providerLimitSeconds;
    this.#readyLimitReason = args.readyLimitReason;
    this.#remainingAtAdmission = args.remainingAtAdmission;
  }

  get readyLimitReason(): RealtimeFinishedReason {
    return this.#readyLimitReason;
  }

  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  setAdmission(admission: {
    readonly providerLimitSeconds: number;
    readonly readyLimitReason: RealtimeFinishedReason;
    readonly remainingAtAdmission: number;
  }): void {
    this.#providerLimitSeconds = admission.providerLimitSeconds;
    this.#readyLimitReason = admission.readyLimitReason;
    this.#remainingAtAdmission = admission.remainingAtAdmission;
  }

  abortStart(): void {
    this.#abortController.abort();
  }

  async connect(client: RealtimeTranscriptionClient, terms: readonly string[]): Promise<void> {
    this.#throwIfClosed();
    try {
      this.#provider = await client.connect({
        audio: this.#request.audio,
        terms,
        signal: this.#providerSignal,
        onEvent: (event) => this.#handleProviderEvent(event),
      });
    } catch (error) {
      this.#abortController.abort();
      throw error;
    }

    this.#throwIfClosed();

    onProviderClosed({
      provider: this.#provider,
      isClosed: () => this.#state === "closed",
      beginError: (code) => void this.#beginTerminal({ kind: "error", code }),
    });
    emitRealtimeReady({
      request: this.#request,
      providerLimitSeconds: this.#providerLimitSeconds,
      remainingAtAdmission: this.#remainingAtAdmission,
    });
    this.#timers.startWallClock(
      () => void this.#beginFinish(this.readyLimitReason),
      this.#providerLimitSeconds * 1_000,
    );
    this.#timers.startFirstAudio(
      () => void this.#beginTerminal({ kind: "error", code: RealtimeProtocolErrorCode.AudioTimeout }),
      this.#policy.firstAudioTimeoutMs,
    );
  }

  sendAudio(data: Buffer): void {
    if (this.#state !== "streaming") {
      return;
    }

    this.#timers.clearFirstAudio();
    const result = sendRealtimeAudioFrame({
      provider: this.#provider,
      request: this.#request,
      data,
      attemptedBytes: this.#attemptedBytes,
      limitSeconds: this.#providerLimitSeconds,
    });

    switch (result.kind) {
      case "sent":
        this.#attemptedBytes = result.attemptedBytes;
        if (result.reachedLimit) {
          void this.#beginFinish(this.readyLimitReason);
        }
        break;
      case "limit":
        void this.#beginFinish(this.readyLimitReason);
        break;
      case "invalid":
        void this.#beginTerminal({ kind: "error", code: RealtimeProtocolErrorCode.InvalidAudio });
        break;
      case "error":
        void this.#beginTerminal({ kind: "error", code: result.code });
        break;
      default:
        throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.InternalError);
    }
  }

  finish(): Promise<void> {
    return this.#beginFinish(RealtimeFinishedReason.Finished);
  }

  cancel(): Promise<void> {
    return this.#beginTerminal({ kind: "silent" });
  }

  disconnect(): Promise<void> {
    return this.#beginTerminal({ kind: "silent" });
  }

  shutdown(): Promise<void> {
    return this.#beginTerminal({ kind: "error", code: RealtimeProtocolErrorCode.ServiceRestarting });
  }

  forceClose(): void {
    this.#timers.clearAll();
    this.#state = "closed";
    forceCloseProvider({
      abortController: this.#abortController,
      provider: this.#provider,
      resolveClosed: () => this.#closed.resolve(),
    });
  }

  #beginFinish(reason: RealtimeFinishedReason): Promise<void> {
    if (this.#state === "closed") {
      return this.#closed.promise;
    }

    if (this.#finishPromise !== null) {
      return this.#finishPromise;
    }

    this.#timers.clearFirstAudio();
    this.#state = "finishing";
    this.#finishReason = reason;
    this.#timers.clearWallClock();
    this.#finishPromise = this.#finishProvider();
    return this.#finishPromise;
  }

  async #finishProvider(): Promise<void> {
    await finishRealtimeProvider({
      provider: this.#provider,
      billableSeconds: this.#billableSeconds,
      finishTimeoutMs: this.#policy.finishTimeoutMs,
      completeWithoutProvider: () => this.#beginTerminal({ kind: "complete", reason: this.#finishReason }),
      fail: (code) => this.#beginTerminal({ kind: "error", code }),
    });
  }

  #handleProviderEvent(event: RealtimeProviderEvent): void {
    if (this.#state === "closed") {
      return;
    }

    switch (event.type) {
      case "transcript":
        this.#providerProgressMs = Math.max(this.#providerProgressMs, event.finalAudioMs, event.totalAudioMs);
        if (event.confirmedDelta.length > 0 || event.provisional.length > 0) {
          if (
            !emitTranscriptEvent({
              callbacks: this.#request.callbacks,
              confirmedDelta: event.confirmedDelta,
              provisional: event.provisional,
            })
          ) {
            void this.#beginTerminal({ kind: "error", code: RealtimeProtocolErrorCode.InternalError });
          }
        }
        break;
      case "finished":
        if (this.#state === "finishing") {
          void this.#beginTerminal({ kind: "complete", reason: this.#finishReason });
        }
        break;
      default:
        throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.InternalError);
    }
  }

  #beginTerminal(decision: TerminalDecision): Promise<void> {
    this.#terminalPromise ??= this.#runTerminal(decision);
    return this.#terminalPromise;
  }

  async #runTerminal(decision: TerminalDecision): Promise<void> {
    this.#timers.clearAll();
    this.#abortController.abort();
    this.#state = "closed";
    if (decision.kind !== "complete") {
      this.#provider?.cancel();
    }

    const remaining = await this.#service.recordUsage({
      userId: this.#request.userId,
      seconds: this.#billableSeconds,
      remainingAtAdmission: this.#remainingAtAdmission,
    });
    emitTerminalEvent({ callbacks: this.#request.callbacks, decision, remaining });
    this.#service.release(this);
    this.#closed.resolve();
  }

  get #billableSeconds(): number {
    return billableRealtimeSeconds({
      request: this.#request,
      attemptedBytes: this.#attemptedBytes,
      providerProgressMs: this.#providerProgressMs,
    });
  }

  #throwIfClosed(): void {
    if (this.#state === "closed" || this.#providerSignal.aborted) {
      throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.ServiceRestarting);
    }
  }
}

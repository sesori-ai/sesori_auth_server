import type {
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
import {
  RealtimeFinishedReason,
  RealtimeProtocolErrorCode,
  RealtimeProviderEventType,
  type RealtimeProviderEvent,
} from "../types/transcription.js";
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
  readonly #now: () => number;
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
  #streamStartedAtMs = 0;

  constructor(args: {
    readonly service: RealtimeSessionOwner;
    readonly request: RealtimeStartRequest;
    readonly policy: RealtimeTranscriptionPolicy;
    readonly providerLimitSeconds: number;
    readonly readyLimitReason: RealtimeFinishedReason;
    readonly remainingAtAdmission: number;
    readonly now?: () => number;
  }) {
    this.#service = args.service;
    this.#request = args.request;
    this.#policy = args.policy;
    this.#now = args.now ?? (() => Date.now());
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
        maxAudioDurationMs: this.#providerLimitSeconds * 1_000,
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
      beginTerminal: (decision) => this.#beginTerminalDetached(decision),
    });
    emitRealtimeReady({
      request: this.#request,
      providerLimitSeconds: this.#providerLimitSeconds,
      remainingAtAdmission: this.#remainingAtAdmission,
    });
    this.#streamStartedAtMs = this.#now();
    this.#timers.startWallClock(
      () => this.#beginFinishDetached(this.readyLimitReason),
      this.#providerLimitSeconds * 1_000,
    );
    this.#armAudioDeadline();
  }

  sendAudio(data: Buffer): void {
    if (this.#state !== "streaming") {
      return;
    }

    // Inbound flow control is a pacing budget rather than socket pause/resume plus a provider-side
    // bufferedAmount watermark. Pacing needs no transport detail on the provider-neutral session
    // contract, and it bounds what can ever be in flight: a client may not run more than the burst
    // allowance ahead of real time, so the provider send queue stays bounded no matter how fast the
    // client uplink is or how hard the provider applies backpressure. The cumulative session cap
    // alone permits the whole session's audio to arrive at once.
    const result = sendRealtimeAudioFrame({
      provider: this.#provider,
      request: this.#request,
      data,
      attemptedBytes: this.#attemptedBytes,
      limitSeconds: this.#providerLimitSeconds,
      elapsedMs: this.#now() - this.#streamStartedAtMs,
      paceBurstSeconds: this.#policy.audioPaceBurstSeconds,
    });

    switch (result.kind) {
      case "sent":
        this.#attemptedBytes = result.attemptedBytes;
        // Rearm only once the frame is accepted. Clearing before validation would let one junk
        // frame retire the deadline permanently, and never rearming leaves a silent session
        // holding both sockets until the wall clock expires.
        this.#armAudioDeadline();
        if (result.reachedLimit) {
          this.#beginFinishDetached(this.readyLimitReason);
        }
        break;
      case "limit":
        this.#beginFinishDetached(this.readyLimitReason);
        break;
      case "pace":
      case "invalid":
        this.#beginTerminalDetached({ kind: "error", code: RealtimeProtocolErrorCode.InvalidAudio });
        break;
      case "error":
        this.#beginTerminalDetached({ kind: "error", code: result.code });
        break;
      default:
        throw new RealtimeAdmissionError(RealtimeProtocolErrorCode.InternalError);
    }
  }

  #armAudioDeadline(): void {
    this.#timers.startAudioDeadline(
      () => this.#beginTerminalDetached({ kind: "error", code: RealtimeProtocolErrorCode.AudioTimeout }),
      this.#policy.firstAudioTimeoutMs,
    );
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

  /** Fire-and-forget finish entry; see `#beginTerminalDetached` for why. */
  #beginFinishDetached(reason: RealtimeFinishedReason): void {
    void this.#beginFinish(reason).catch(() => undefined);
  }

  #beginFinish(reason: RealtimeFinishedReason): Promise<void> {
    if (this.#state === "closed") {
      return this.#closed.promise;
    }

    if (this.#finishPromise !== null) {
      return this.#finishPromise;
    }

    this.#timers.clearAudioDeadline();
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
      case RealtimeProviderEventType.Transcript:
        if (
          event.finalAudioMs > this.#providerLimitSeconds * 1_000 ||
          event.totalAudioMs > this.#providerLimitSeconds * 1_000
        ) {
          this.#beginTerminalDetached({
            kind: "error",
            code: RealtimeProtocolErrorCode.InternalError,
            recordUsage: false,
          });
          return;
        }

        this.#providerProgressMs = Math.max(this.#providerProgressMs, event.finalAudioMs, event.totalAudioMs);
        if (event.confirmedDelta.length > 0 || event.provisional.length > 0) {
          if (
            !emitTranscriptEvent({
              callbacks: this.#request.callbacks,
              confirmedDelta: event.confirmedDelta,
              provisional: event.provisional,
            })
          ) {
            this.#beginTerminalDetached({ kind: "error", code: RealtimeProtocolErrorCode.InternalError });
          }
        }
        break;
      case RealtimeProviderEventType.Finished:
        if (this.#state === "finishing") {
          this.#beginTerminalDetached({ kind: "complete", reason: this.#finishReason });
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

  /**
   * Fire-and-forget terminal entry. `#runTerminal` still rejects so awaiting
   * callers (`finish`, `cancel`, `shutdown`) see the failure, but these call
   * sites have nobody to report to: leaving the rejection unhandled would turn
   * a throwing client callback into a process-level unhandled rejection, which
   * is a worse outcome than the terminal the session already completed.
   */
  #beginTerminalDetached(decision: TerminalDecision): void {
    void this.#beginTerminal(decision).catch(() => undefined);
  }

  async #runTerminal(decision: TerminalDecision): Promise<void> {
    this.#timers.clearAll();
    this.#abortController.abort();
    this.#state = "closed";
    if (decision.kind !== "complete") {
      this.#provider?.cancel();
    }

    try {
      const remaining =
        decision.kind === "error" && decision.recordUsage === false
          ? this.#remainingAtAdmission
          : await this.#service.recordUsage({
              userId: this.#request.userId,
              seconds: this.#billableSeconds,
              remainingAtAdmission: this.#remainingAtAdmission,
            });
      emitTerminalEvent({ callbacks: this.#request.callbacks, decision, remaining });
    } finally {
      // Ordering is deliberate: the usage write and the terminal emit run
      // first, so a successful terminal still reports before the slot frees.
      // But neither may gate cleanup — a rejected usage write or a throwing
      // client callback would otherwise strand a concurrency slot for the
      // process lifetime and leave `closed` pending, which hangs dispose().
      this.#service.release(this);
      this.#closed.resolve();
    }
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

export function setSessionTimer(callback: () => void, timeoutMs: number): NodeJS.Timeout {
  const timer = setTimeout(callback, timeoutMs);
  timer.unref();
  return timer;
}

/**
 * Arms a deadline and returns its cancel.
 *
 * Injected wherever a deadline decides observable behaviour, so a test can fire it exactly once
 * at a point it chooses instead of sleeping past a real `setTimeout` and hoping the event loop
 * cooperated. A test that races the wall clock either passes for the wrong reason under load or
 * fails for one, and neither outcome says anything about the deadline it meant to pin.
 */
export type RealtimeTimeoutScheduler = (callback: () => void, timeoutMs: number) => () => void;

export const scheduleUnrefTimeout: RealtimeTimeoutScheduler = (callback, timeoutMs) => {
  const timer = setSessionTimer(callback, timeoutMs);
  return () => clearTimeout(timer);
};

export class RealtimeSessionTimers {
  readonly #schedule: RealtimeTimeoutScheduler;
  #cancelAudioDeadline: (() => void) | null = null;
  #cancelWallClock: (() => void) | null = null;

  constructor(schedule: RealtimeTimeoutScheduler = scheduleUnrefTimeout) {
    this.#schedule = schedule;
  }

  /** Arms the first-audio deadline, and rearms it as a rolling idle deadline on later frames. */
  startAudioDeadline(callback: () => void, timeoutMs: number): void {
    this.clearAudioDeadline();
    this.#cancelAudioDeadline = this.#schedule(callback, timeoutMs);
  }

  startWallClock(callback: () => void, timeoutMs: number): void {
    this.clearWallClock();
    this.#cancelWallClock = this.#schedule(callback, timeoutMs);
  }

  clearAudioDeadline(): void {
    if (this.#cancelAudioDeadline !== null) {
      this.#cancelAudioDeadline();
      this.#cancelAudioDeadline = null;
    }
  }

  clearWallClock(): void {
    if (this.#cancelWallClock !== null) {
      this.#cancelWallClock();
      this.#cancelWallClock = null;
    }
  }

  clearAll(): void {
    this.clearAudioDeadline();
    this.clearWallClock();
  }
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      // Unref'd like every other realtime timer: a disposal race that is still
      // pending must not be the reason the process refuses to exit.
      new Promise<never>((_resolve, reject) => {
        timer = setSessionTimer(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve: ((value: T | PromiseLike<T>) => void) | null = null;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.#resolve = resolve;
    });
  }

  resolve(value: T): void {
    this.#resolve?.(value);
    this.#resolve = null;
  }
}

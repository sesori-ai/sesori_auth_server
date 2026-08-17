export function setSessionTimer(callback: () => void, timeoutMs: number): NodeJS.Timeout {
  const timer = setTimeout(callback, timeoutMs);
  timer.unref();
  return timer;
}

export class RealtimeSessionTimers {
  #audioDeadlineTimer: NodeJS.Timeout | null = null;
  #wallClockTimer: NodeJS.Timeout | null = null;

  /** Arms the first-audio deadline, and rearms it as a rolling idle deadline on later frames. */
  startAudioDeadline(callback: () => void, timeoutMs: number): void {
    this.clearAudioDeadline();
    this.#audioDeadlineTimer = setSessionTimer(callback, timeoutMs);
  }

  startWallClock(callback: () => void, timeoutMs: number): void {
    this.clearWallClock();
    this.#wallClockTimer = setSessionTimer(callback, timeoutMs);
  }

  clearAudioDeadline(): void {
    if (this.#audioDeadlineTimer !== null) {
      clearTimeout(this.#audioDeadlineTimer);
      this.#audioDeadlineTimer = null;
    }
  }

  clearWallClock(): void {
    if (this.#wallClockTimer !== null) {
      clearTimeout(this.#wallClockTimer);
      this.#wallClockTimer = null;
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

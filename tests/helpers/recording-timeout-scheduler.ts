import type { RealtimeTimeoutScheduler } from "../../src/services/realtime-session-utils.js";

export class RecordedTimeout {
  cancelCount = 0;
  readonly timeoutMs: number;
  readonly fire: () => void;

  constructor(timeoutMs: number, fire: () => void) {
    this.timeoutMs = timeoutMs;
    this.fire = fire;
  }
}

/**
 * Captures the deadlines a realtime component arms, so a test can fire exactly one of them at a
 * moment it chooses and observe which of the rest were cancelled.
 *
 * The alternative is arming a real short timer and sleeping past it, which makes the assertion
 * depend on the event loop being responsive at that instant. Under load such a test either fires
 * late and fails for a reason unrelated to the deadline, or fires during a step that assumed it
 * had not yet — and a test that can fail without the code changing stops being evidence about the
 * code. Recording the arm also pins the duration, which a sleep never observed at all.
 */
export class RecordingTimeoutScheduler {
  readonly armed: RecordedTimeout[] = [];

  readonly schedule: RealtimeTimeoutScheduler = (callback, timeoutMs) => {
    const recorded = new RecordedTimeout(timeoutMs, callback);
    this.armed.push(recorded);
    return () => {
      recorded.cancelCount += 1;
    };
  };

  armedWith(timeoutMs: number): readonly RecordedTimeout[] {
    return this.armed.filter((timeout) => timeout.timeoutMs === timeoutMs);
  }
}

import {
  ActivationReminderKind,
  type ActivationStateRepository,
  type DueActivationReminder,
} from "../repositories/activation-state-repo.js";
import { safeErrorType } from "../lib/errors.js";
import type { NotificationPayload, NotificationService } from "./notification-service.js";

export const ACTIVATION_REMINDER_DISPOSE_TIMEOUT_MS = 15_000;

// Evaluate the follow-up before the first bridge reminder so a marker written
// later in this sweep cannot make both messages send back-to-back.
const REMINDER_KINDS = [
  ActivationReminderKind.Bridge2,
  ActivationReminderKind.Bridge1,
  ActivationReminderKind.Session,
] as const;

const REMINDER_PAYLOADS: Record<ActivationReminderKind, NotificationPayload> = {
  [ActivationReminderKind.Bridge1]: {
    category: "system_update",
    title: "Finish setting up Sesori",
    body: "Install the Sesori bridge on your computer to connect your coding agents.",
    collapseKey: "activation_bridge_1",
  },
  [ActivationReminderKind.Bridge2]: {
    category: "system_update",
    title: "Your Sesori setup is unfinished",
    body: "You haven't connected your computer yet. Install the Sesori bridge to unlock Sesori.",
    collapseKey: "activation_bridge_2",
  },
  [ActivationReminderKind.Session]: {
    category: "system_update",
    title: "Start your first session",
    body: "You're all set up! You haven't started a new session yet - create one to put Sesori to work.",
    collapseKey: "activation_first_session",
  },
};

export type ActivationReminderServiceOptions = {
  enabled: boolean;
  sweepIntervalMs: number;
  bridgeReminder1DelayMs: number;
  bridgeReminder2DelayMs: number;
  sessionReminderDelayMs: number;
  batchLimit: number;
};

export type ActivationReminderCounters = {
  due: number;
  sent: number;
  noDevices: number;
  skipped: number;
  failed: number;
};

export enum ActivationSweepStatus {
  Disabled = "disabled",
  Unavailable = "unavailable",
  Completed = "completed",
}

export type ActivationReminderSweepResult = {
  status: ActivationSweepStatus;
  reminders: Record<ActivationReminderKind, ActivationReminderCounters>;
};

function emptyCounters(): ActivationReminderCounters {
  return { due: 0, sent: 0, noDevices: 0, skipped: 0, failed: 0 };
}

function emptyResult(status: ActivationSweepStatus): ActivationReminderSweepResult {
  return {
    status,
    reminders: {
      [ActivationReminderKind.Bridge1]: emptyCounters(),
      [ActivationReminderKind.Bridge2]: emptyCounters(),
      [ActivationReminderKind.Session]: emptyCounters(),
    },
  };
}

export class ActivationReminderService {
  readonly #activationStateRepo: ActivationStateRepository;
  readonly #notificationService: NotificationService;
  readonly #options: ActivationReminderServiceOptions;
  readonly #disposalAbortController = new AbortController();
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<ActivationReminderSweepResult> | null = null;
  #disposePromise: Promise<void> | null = null;
  #resolveForceFence: (() => void) | null = null;
  #disposed = false;
  #forceFenced = false;
  #disposeTimedOut = false;

  constructor(deps: {
    activationStateRepo: ActivationStateRepository;
    notificationService: NotificationService;
    options: ActivationReminderServiceOptions;
  }) {
    this.#activationStateRepo = deps.activationStateRepo;
    this.#notificationService = deps.notificationService;
    this.#options = deps.options;
  }

  start(): void {
    if (!this.#options.enabled || this.#disposed || this.#timer) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.sweepOnce();
    }, this.#options.sweepIntervalMs);
    this.#timer.unref?.();
    console.log("[ActivationReminderService] Scheduler started", {
      intervalMs: this.#options.sweepIntervalMs,
      batchLimit: this.#options.batchLimit,
    });
  }

  sweepOnce(now = new Date()): Promise<ActivationReminderSweepResult> {
    if (!this.#options.enabled || this.#disposed) {
      return Promise.resolve(emptyResult(ActivationSweepStatus.Disabled));
    }

    if (!this.#notificationService.isAvailable) {
      console.warn("[ActivationReminderService] FCM unavailable, reminder sweep skipped", { at: now });
      return Promise.resolve(emptyResult(ActivationSweepStatus.Unavailable));
    }

    if (this.#inFlight) {
      return this.#inFlight;
    }

    const sweep = this.#runSweep(now);
    this.#inFlight = sweep;
    void sweep.then(
      () => {
        if (this.#inFlight === sweep) {
          this.#inFlight = null;
        }
      },
      () => {
        if (this.#inFlight === sweep) {
          this.#inFlight = null;
        }
      },
    );
    return sweep;
  }

  dispose(): Promise<void> {
    this.#stop();

    if (!this.#disposePromise) {
      const inFlight = this.#inFlight;
      this.#disposePromise = inFlight ? this.#drain(inFlight) : Promise.resolve();
    }

    return this.#disposePromise;
  }

  forceFence(): void {
    this.#stop();
    if (this.#forceFenced) {
      return;
    }

    this.#forceFenced = true;
    this.#disposalAbortController.abort();
    this.#resolveForceFence?.();
  }

  async #drain(inFlight: Promise<ActivationReminderSweepResult>): Promise<void> {
    let resolveForceFence!: () => void;
    const forceFencePromise = new Promise<void>((resolve) => {
      resolveForceFence = resolve;
      this.#resolveForceFence = resolve;
    });
    if (this.#forceFenced) {
      resolveForceFence();
    }

    const timeout = setTimeout(() => {
      this.#disposeTimedOut = true;
      this.forceFence();
    }, ACTIVATION_REMINDER_DISPOSE_TIMEOUT_MS);
    timeout.unref?.();

    try {
      await Promise.race([inFlight.then(() => undefined), forceFencePromise]);
    } finally {
      clearTimeout(timeout);
      if (this.#resolveForceFence === resolveForceFence) {
        this.#resolveForceFence = null;
      }
    }

    if (this.#disposeTimedOut) {
      console.warn("[ActivationReminderService] Disposal timed out with reminder delivery still in flight", {
        timeoutMs: ACTIVATION_REMINDER_DISPOSE_TIMEOUT_MS,
      });
    }
  }

  #stop(): void {
    this.#disposed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #runSweep(now: Date): Promise<ActivationReminderSweepResult> {
    const result = emptyResult(ActivationSweepStatus.Completed);
    for (const kind of REMINDER_KINDS) {
      if (this.#disposed) {
        break;
      }

      try {
        result.reminders[kind] = await this.#processKind(kind, now);
      } catch (error) {
        result.reminders[kind].failed += 1;
        console.warn("[ActivationReminderService] Reminder query failed", {
          kind,
          errorType: safeErrorType({ error }),
        });
      }
    }
    console.log("[ActivationReminderService] Sweep completed", { at: now, reminders: result.reminders });
    return result;
  }

  async #processKind(kind: ActivationReminderKind, now: Date): Promise<ActivationReminderCounters> {
    const cutoff = new Date(now.getTime() - this.#delayFor(kind));
    const due = await this.#activationStateRepo.findDueReminders(kind, cutoff, this.#options.batchLimit);
    const counters = emptyCounters();
    counters.due = due.length;

    for (const reminder of due) {
      if (this.#disposed) {
        break;
      }

      await this.#processReminder(kind, reminder, cutoff, counters);
    }
    return counters;
  }

  async #processReminder(
    kind: ActivationReminderKind,
    reminder: DueActivationReminder,
    cutoff: Date,
    counters: ActivationReminderCounters,
  ): Promise<void> {
    let stage: "eligibility" | "send" | "marker" = "eligibility";
    try {
      if (!(await this.#activationStateRepo.isReminderStillDue(reminder.userId, kind, cutoff))) {
        counters.skipped += 1;
        console.log("[ActivationReminderService] Reminder skipped before send", { kind, userId: reminder.userId });
        return;
      }

      if (this.#disposed) {
        return;
      }

      stage = "send";
      const { devicesNotified, retryableFailures } = await this.#notificationService.sendToUser(
        reminder.userId,
        REMINDER_PAYLOADS[kind],
        this.#disposalAbortController.signal,
      );
      if (this.#forceFenced) {
        counters.failed += 1;
        return;
      }

      // Resolved delivery outcomes:
      // - zero success + zero retryable failures: complete (no tokens or only stale tokens)
      // - at least one success: complete, even if another token failed transiently
      // - zero success + retryable failures: keep eligible for the next sweep
      if (devicesNotified === 0 && retryableFailures > 0) {
        counters.failed += 1;
        console.warn("[ActivationReminderService] Reminder delivery unresolved", {
          kind,
          retryableFailures,
        });
        return;
      }

      const sentAt = new Date();
      stage = "marker";
      const marked = await this.#activationStateRepo.markReminderSentIfStillDue(reminder.userId, kind, cutoff, sentAt);
      if (this.#forceFenced) {
        counters.failed += 1;
        return;
      }

      if (!marked) {
        counters.skipped += 1;
        console.log("[ActivationReminderService] Reminder no longer eligible after send", {
          kind,
          userId: reminder.userId,
        });
        return;
      }

      counters.sent += 1;
      if (devicesNotified === 0) {
        counters.noDevices += 1;
      }

      console.log("[ActivationReminderService] Reminder sent", {
        kind,
        userId: reminder.userId,
        baselineAt: reminder.baselineAt,
        sentAt,
        devicesNotified,
        retryableFailures,
      });
    } catch (error) {
      counters.failed += 1;
      if (stage === "send" && this.#disposalAbortController.signal.aborted) {
        return;
      }

      console.warn("[ActivationReminderService] Reminder failed and remains retryable", {
        kind,
        errorType: safeErrorType({ error }),
      });
    }
  }

  #delayFor(kind: ActivationReminderKind): number {
    switch (kind) {
      case ActivationReminderKind.Bridge1:
        return this.#options.bridgeReminder1DelayMs;
      case ActivationReminderKind.Bridge2:
        return this.#options.bridgeReminder2DelayMs;
      case ActivationReminderKind.Session:
        return this.#options.sessionReminderDelayMs;
    }
  }
}

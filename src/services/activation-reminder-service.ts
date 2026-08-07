import {
  ActivationReminderKind,
  type ActivationStateRepository,
  type DueActivationReminder,
} from "../repositories/activation-state-repo.js";
import type { NotificationPayload, NotificationService } from "./notification-service.js";
import { NotificationCategory } from "../models/notification.js";

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
    category: NotificationCategory.SystemUpdate,
    title: "Finish setting up Sesori",
    body: "Install the Sesori bridge on your computer to connect your coding agents.",
    collapseKey: "activation_bridge_1",
  },
  [ActivationReminderKind.Bridge2]: {
    category: NotificationCategory.SystemUpdate,
    title: "Your Sesori setup is unfinished",
    body: "You haven't connected your computer yet. Install the Sesori bridge to unlock Sesori.",
    collapseKey: "activation_bridge_2",
  },
  [ActivationReminderKind.Session]: {
    category: NotificationCategory.SystemUpdate,
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
  #disposed = false;
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

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    const inFlight = this.#inFlight;
    if (!inFlight) {
      return;
    }

    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        this.#disposeTimedOut = true;
        this.#disposalAbortController.abort();
        resolve();
      }, ACTIVATION_REMINDER_DISPOSE_TIMEOUT_MS);
      timeout.unref?.();
    });
    await Promise.race([inFlight.then(() => undefined), timeoutPromise]);
    if (timeout) {
      clearTimeout(timeout);
    }

    if (timedOut) {
      console.warn("[ActivationReminderService] Disposal timed out with reminder delivery still in flight", {
        timeoutMs: ACTIVATION_REMINDER_DISPOSE_TIMEOUT_MS,
      });
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
        console.warn("[ActivationReminderService] Reminder query failed", { kind, error });
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
    try {
      if (!(await this.#activationStateRepo.isReminderStillDue(reminder.userId, kind, cutoff))) {
        counters.skipped += 1;
        console.log("[ActivationReminderService] Reminder skipped before send", { kind, userId: reminder.userId });
        return;
      }

      if (this.#disposed) {
        return;
      }

      const { devicesNotified, retryableFailures } = await this.#notificationService.sendToUserIgnoringDeviceSettings(
        reminder.userId,
        REMINDER_PAYLOADS[kind],
        this.#disposalAbortController.signal,
      );
      if (this.#disposeTimedOut) {
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
          userId: reminder.userId,
          retryableFailures,
        });
        return;
      }

      const sentAt = new Date();
      const marked = await this.#activationStateRepo.markReminderSentIfStillDue(reminder.userId, kind, cutoff, sentAt);
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
      console.warn("[ActivationReminderService] Reminder failed and remains retryable", {
        kind,
        userId: reminder.userId,
        error,
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

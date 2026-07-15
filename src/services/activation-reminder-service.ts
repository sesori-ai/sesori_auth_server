import type {
  ActivationReminderKind,
  ActivationStateRepository,
  DueActivationReminder,
} from "../repositories/activation-state-repo.js";
import type { NotificationPayload, NotificationService } from "./notification-service.js";

const REMINDER_KINDS = ["bridge_1", "bridge_2", "session"] as const satisfies readonly ActivationReminderKind[];

const REMINDER_PAYLOADS: Record<ActivationReminderKind, NotificationPayload> = {
  bridge_1: {
    category: "system_update",
    title: "Finish setting up Sesori",
    body: "Install the Sesori bridge on your computer to start using Sesori from your phone.",
    collapseKey: "activation_bridge_1",
  },
  bridge_2: {
    category: "system_update",
    title: "Your Sesori setup is unfinished",
    body: "You haven't connected your computer yet. Install the Sesori bridge to unlock Sesori.",
    collapseKey: "activation_bridge_2",
  },
  session: {
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

export type ActivationReminderSweepResult = {
  status: "disabled" | "unavailable" | "completed";
  reminders: Record<ActivationReminderKind, ActivationReminderCounters>;
};

function emptyCounters(): ActivationReminderCounters {
  return { due: 0, sent: 0, noDevices: 0, skipped: 0, failed: 0 };
}

function emptyResult(status: ActivationReminderSweepResult["status"]): ActivationReminderSweepResult {
  return {
    status,
    reminders: {
      bridge_1: emptyCounters(),
      bridge_2: emptyCounters(),
      session: emptyCounters(),
    },
  };
}

export class ActivationReminderService {
  readonly #activationStateRepo: ActivationStateRepository;
  readonly #notificationService: NotificationService;
  readonly #options: ActivationReminderServiceOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<ActivationReminderSweepResult> | null = null;
  #disposed = false;

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
      return Promise.resolve(emptyResult("disabled"));
    }
    if (!this.#notificationService.isAvailable) {
      console.warn("[ActivationReminderService] FCM unavailable, reminder sweep skipped", { at: now });
      return Promise.resolve(emptyResult("unavailable"));
    }
    if (this.#inFlight) {
      return this.#inFlight;
    }

    const sweep = this.#runSweep(now);
    this.#inFlight = sweep;
    void sweep.then(
      () => {
        if (this.#inFlight === sweep) this.#inFlight = null;
      },
      () => {
        if (this.#inFlight === sweep) this.#inFlight = null;
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
    await this.#inFlight;
  }

  async #runSweep(now: Date): Promise<ActivationReminderSweepResult> {
    const result = emptyResult("completed");
    for (const kind of REMINDER_KINDS) {
      if (this.#disposed) break;
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
      if (this.#disposed) break;
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

      if (this.#disposed) return;

      const { devicesNotified, retryableFailures } = await this.#notificationService.sendToUser(
        reminder.userId,
        REMINDER_PAYLOADS[kind],
      );
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
      if (devicesNotified === 0) counters.noDevices += 1;
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
      case "bridge_1":
        return this.#options.bridgeReminder1DelayMs;
      case "bridge_2":
        return this.#options.bridgeReminder2DelayMs;
      case "session":
        return this.#options.sessionReminderDelayMs;
    }
  }
}

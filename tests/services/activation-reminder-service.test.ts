import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  ActivationReminderKind,
  type ActivationStateRepository,
  type DueActivationReminder,
} from "../../src/repositories/activation-state-repo.js";
import {
  ACTIVATION_REMINDER_DISPOSE_TIMEOUT_MS,
  ActivationReminderService,
  ActivationSweepStatus,
  type ActivationReminderServiceOptions,
} from "../../src/services/activation-reminder-service.js";
import type {
  NotificationDeliveryResult,
  NotificationPayload,
  NotificationService,
} from "../../src/services/notification-service.js";
import { SHUTDOWN_HARD_DEADLINE_MS, createShutdownCoordinator } from "../../src/shutdown.js";

type SendCall = { userId: string; payload: NotificationPayload; abortSignal?: AbortSignal };
type MarkCall = { userId: string; kind: ActivationReminderKind; cutoff: Date; sentAt: Date };

const NOW = new Date("2026-07-15T12:00:00.000Z");
const DEFAULT_OPTIONS: ActivationReminderServiceOptions = {
  enabled: true,
  sweepIntervalMs: 1_000,
  bridgeReminder1DelayMs: 2_000,
  bridgeReminder2DelayMs: 24_000,
  sessionReminderDelayMs: 24_000,
  batchLimit: 5,
};

function candidate(userId: string): DueActivationReminder {
  return { userId, baselineAt: new Date("2026-07-15T10:00:00.000Z") };
}

function emptyDue(): Record<ActivationReminderKind, DueActivationReminder[]> {
  return {
    [ActivationReminderKind.Bridge1]: [],
    [ActivationReminderKind.Bridge2]: [],
    [ActivationReminderKind.Session]: [],
  };
}

function createRepo(args?: {
  due?: Partial<Record<ActivationReminderKind, DueActivationReminder[]>>;
  find?: (
    kind: ActivationReminderKind,
    cutoff: Date,
    batchLimit: number,
  ) => DueActivationReminder[] | Promise<DueActivationReminder[]>;
  isDue?: (userId: string, kind: ActivationReminderKind) => boolean | Promise<boolean>;
  mark?: (userId: string, kind: ActivationReminderKind) => boolean | Promise<boolean>;
}) {
  const due = { ...emptyDue(), ...args?.due };
  const findCalls: { kind: ActivationReminderKind; cutoff: Date; batchLimit: number }[] = [];
  const checkCalls: { userId: string; kind: ActivationReminderKind; cutoff: Date }[] = [];
  const markCalls: MarkCall[] = [];
  const repo = {
    findDueReminders: async (kind: ActivationReminderKind, cutoff: Date, batchLimit: number) => {
      findCalls.push({ kind, cutoff, batchLimit });
      if (args?.find) {
        return (await args.find(kind, cutoff, batchLimit)).slice(0, batchLimit);
      }

      return due[kind].slice(0, batchLimit);
    },
    isReminderStillDue: async (userId: string, kind: ActivationReminderKind, cutoff: Date) => {
      checkCalls.push({ userId, kind, cutoff });
      return (await args?.isDue?.(userId, kind)) ?? true;
    },
    markReminderSentIfStillDue: async (userId: string, kind: ActivationReminderKind, cutoff: Date, sentAt: Date) => {
      markCalls.push({ userId, kind, cutoff, sentAt });
      return (await args?.mark?.(userId, kind)) ?? true;
    },
  } as unknown as ActivationStateRepository;
  return { repo, findCalls, checkCalls, markCalls };
}

function createNotification(args?: {
  available?: boolean;
  send?: (
    userId: string,
    payload: NotificationPayload,
    abortSignal?: AbortSignal,
  ) => Promise<NotificationDeliveryResult>;
}) {
  const sendCalls: SendCall[] = [];
  const service = {
    isAvailable: args?.available ?? true,
    sendToUser: async (userId: string, payload: NotificationPayload, abortSignal?: AbortSignal) => {
      sendCalls.push({ userId, payload, abortSignal });
      return args?.send?.(userId, payload, abortSignal) ?? { devicesNotified: 1, retryableFailures: 0 };
    },
  } as unknown as NotificationService;
  return { service, sendCalls };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("ActivationReminderService", () => {
  let logCalls: unknown[][];
  let warnCalls: unknown[][];

  beforeEach(() => {
    logCalls = [];
    warnCalls = [];
    mock.method(console, "log", (...args: unknown[]) => {
      logCalls.push(args);
    });
    mock.method(console, "warn", (...args: unknown[]) => {
      warnCalls.push(args);
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("sends approved payloads with distinct collapse keys and marks zero-device sends", async () => {
    const repo = createRepo({
      due: {
        [ActivationReminderKind.Bridge1]: [candidate("bridge-1-user")],
        [ActivationReminderKind.Bridge2]: [candidate("bridge-2-user")],
        [ActivationReminderKind.Session]: [candidate("session-user")],
      },
    });
    const notification = createNotification({
      send: async (userId) => ({
        devicesNotified: userId === "session-user" ? 0 : 1,
        retryableFailures: 0,
      }),
    });
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: DEFAULT_OPTIONS,
    });

    const result = await service.sweepOnce(NOW);

    assert.equal(result.status, ActivationSweepStatus.Completed);
    assert.deepEqual(
      notification.sendCalls.map((call) => ({
        userId: call.userId,
        category: call.payload.category,
        title: call.payload.title,
        collapseKey: call.payload.collapseKey,
      })),
      [
        {
          userId: "bridge-2-user",
          category: "system_update",
          title: "Your Sesori setup is unfinished",
          collapseKey: "activation_bridge_2",
        },
        {
          userId: "bridge-1-user",
          category: "system_update",
          title: "Finish setting up Sesori",
          collapseKey: "activation_bridge_1",
        },
        {
          userId: "session-user",
          category: "system_update",
          title: "Start your first session",
          collapseKey: "activation_first_session",
        },
      ],
    );
    assert.equal(repo.markCalls.length, 3);
    assert.ok(repo.findCalls.every((call) => call.batchLimit === DEFAULT_OPTIONS.batchLimit));
    assert.equal(result.reminders[ActivationReminderKind.Session].sent, 1);
    assert.equal(result.reminders[ActivationReminderKind.Session].noDevices, 1);
    assert.equal(
      notification.sendCalls.find((call) => call.payload.collapseKey === "activation_bridge_1")?.payload.body,
      "Install the Sesori bridge on your computer to connect your coding agents.",
    );
    assert.ok(logCalls.some((args) => args[0] === "[ActivationReminderService] Reminder sent"));
    assert.ok(logCalls.some((args) => args[0] === "[ActivationReminderService] Sweep completed"));
  });

  it("evaluates the bridge follow-up before the first reminder", async () => {
    const repo = createRepo();
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: createNotification().service,
      options: DEFAULT_OPTIONS,
    });

    await service.sweepOnce(NOW);

    assert.deepEqual(
      repo.findCalls.map((call) => call.kind),
      [ActivationReminderKind.Bridge2, ActivationReminderKind.Bridge1, ActivationReminderKind.Session],
    );
  });

  it("limits each reminder kind to its configured batch size", async () => {
    const repo = createRepo({
      due: {
        [ActivationReminderKind.Bridge1]: [candidate("user-1"), candidate("user-2"), candidate("user-3")],
      },
    });
    const notification = createNotification();
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: { ...DEFAULT_OPTIONS, batchLimit: 2 },
    });

    const result = await service.sweepOnce(NOW);

    assert.equal(result.reminders[ActivationReminderKind.Bridge1].due, 2);
    assert.equal(notification.sendCalls.length, 2);
    assert.ok(repo.findCalls.every((call) => call.batchLimit === 2));
  });

  it("does nothing when disabled or when FCM is unavailable", async () => {
    const repo = createRepo({ due: { [ActivationReminderKind.Bridge1]: [candidate("user-1")] } });
    const notification = createNotification({ available: false });
    const unavailable = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: DEFAULT_OPTIONS,
    });
    const disabled = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: createNotification().service,
      options: { ...DEFAULT_OPTIONS, enabled: false },
    });

    assert.equal((await unavailable.sweepOnce(NOW)).status, ActivationSweepStatus.Unavailable);
    assert.equal((await disabled.sweepOnce(NOW)).status, ActivationSweepStatus.Disabled);
    assert.equal(repo.findCalls.length, 0);
    assert.equal(notification.sendCalls.length, 0);
    assert.equal(repo.markCalls.length, 0);
  });

  it("rechecks eligibility immediately before sending", async () => {
    const repo = createRepo({
      due: { [ActivationReminderKind.Bridge1]: [candidate("completed-user")] },
      isDue: () => false,
    });
    const notification = createNotification();
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: DEFAULT_OPTIONS,
    });

    const result = await service.sweepOnce(NOW);

    assert.equal(notification.sendCalls.length, 0);
    assert.equal(repo.markCalls.length, 0);
    assert.equal(result.reminders[ActivationReminderKind.Bridge1].skipped, 1);
  });

  it("leaves thrown sends retryable and succeeds on a later sweep", async () => {
    const repo = createRepo({ due: { [ActivationReminderKind.Bridge1]: [candidate("retry-user")] } });
    let attempts = 0;
    const unsafeError = new Error("FCM unavailable for retry-user");
    unsafeError.name = "NotificationSendError";
    const notification = createNotification({
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw unsafeError;
        }

        return { devicesNotified: 1, retryableFailures: 0 };
      },
    });
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: DEFAULT_OPTIONS,
    });

    const first = await service.sweepOnce(NOW);
    await flushMicrotasks();
    const second = await service.sweepOnce(NOW);

    assert.equal(first.reminders[ActivationReminderKind.Bridge1].failed, 1);
    assert.equal(second.reminders[ActivationReminderKind.Bridge1].sent, 1);
    assert.equal(repo.markCalls.length, 1);
    assert.deepEqual(
      warnCalls.filter((args) => args[0] === "[ActivationReminderService] Reminder failed and remains retryable"),
      [
        [
          "[ActivationReminderService] Reminder failed and remains retryable",
          { kind: ActivationReminderKind.Bridge1, errorType: "NotificationSendError" },
        ],
      ],
    );
    assert.equal(JSON.stringify(warnCalls).includes("retry-user"), false);
  });

  it("logs query failures with bounded kind and safe error type only", async () => {
    const unsafeError = new Error("query failed for private-user");
    unsafeError.name = "ActivationQueryError";
    const repo = createRepo({
      find: async (kind) => {
        if (kind === ActivationReminderKind.Bridge2) {
          throw unsafeError;
        }

        return [];
      },
    });
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: createNotification().service,
      options: DEFAULT_OPTIONS,
    });

    await service.sweepOnce(NOW);

    assert.deepEqual(warnCalls, [
      [
        "[ActivationReminderService] Reminder query failed",
        { kind: ActivationReminderKind.Bridge2, errorType: "ActivationQueryError" },
      ],
    ]);
    assert.equal(JSON.stringify(warnCalls).includes("private-user"), false);
  });

  it("does not mark a stage that completes while the notification is sending", async () => {
    const repo = createRepo({
      due: { [ActivationReminderKind.Session]: [candidate("racing-user")] },
      mark: () => false,
    });
    const notification = createNotification();
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: DEFAULT_OPTIONS,
    });

    const result = await service.sweepOnce(NOW);

    assert.equal(notification.sendCalls.length, 1);
    assert.equal(repo.markCalls.length, 1);
    assert.equal(result.reminders[ActivationReminderKind.Session].sent, 0);
    assert.equal(result.reminders[ActivationReminderKind.Session].skipped, 1);
  });

  it("leaves all-transient token failures retryable and succeeds on a later sweep", async () => {
    const repo = createRepo({ due: { [ActivationReminderKind.Bridge1]: [candidate("transient-user")] } });
    let attempts = 0;
    const notification = createNotification({
      send: async () => {
        attempts += 1;
        return attempts === 1
          ? { devicesNotified: 0, retryableFailures: 1 }
          : { devicesNotified: 1, retryableFailures: 0 };
      },
    });
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: DEFAULT_OPTIONS,
    });

    const first = await service.sweepOnce(NOW);
    const second = await service.sweepOnce(NOW);

    assert.equal(first.reminders[ActivationReminderKind.Bridge1].failed, 1);
    assert.equal(second.reminders[ActivationReminderKind.Bridge1].sent, 1);
    assert.equal(repo.markCalls.length, 1);
  });

  it("leaves a successful send retryable when the conditional marker write fails", async () => {
    let markAttempts = 0;
    const unsafeError = new Error("MongoDB unavailable for marker-failure-user");
    unsafeError.name = "ActivationMarkerError";
    const repo = createRepo({
      due: { [ActivationReminderKind.Session]: [candidate("marker-failure-user")] },
      mark: () => {
        markAttempts += 1;
        if (markAttempts === 1) {
          throw unsafeError;
        }

        return true;
      },
    });
    const notification = createNotification();
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: DEFAULT_OPTIONS,
    });

    const first = await service.sweepOnce(NOW);
    await flushMicrotasks();
    const second = await service.sweepOnce(NOW);

    assert.equal(first.reminders[ActivationReminderKind.Session].failed, 1);
    assert.equal(second.reminders[ActivationReminderKind.Session].sent, 1);
    assert.equal(notification.sendCalls.length, 2);
    assert.deepEqual(
      warnCalls.filter((args) => args[0] === "[ActivationReminderService] Reminder failed and remains retryable"),
      [
        [
          "[ActivationReminderService] Reminder failed and remains retryable",
          { kind: ActivationReminderKind.Session, errorType: "ActivationMarkerError" },
        ],
      ],
    );
    assert.equal(JSON.stringify(warnCalls).includes("marker-failure-user"), false);
  });

  it("coalesces concurrent sweeps and dispose drains only the current reminder through its marker", async () => {
    const sendDeferred = createDeferred<NotificationDeliveryResult>();
    const markerDeferred = createDeferred<boolean>();
    const repo = createRepo({
      due: { [ActivationReminderKind.Bridge1]: [candidate("slow-user"), candidate("queued-user")] },
      mark: async () => markerDeferred.promise,
    });
    const notification = createNotification({ send: async () => sendDeferred.promise });
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: DEFAULT_OPTIONS,
    });

    const first = service.sweepOnce(NOW);
    await flushMicrotasks();
    const second = service.sweepOnce(NOW);
    assert.equal(first, second);
    assert.equal(notification.sendCalls.length, 1);

    let disposed = false;
    const disposing = service.dispose().then(() => {
      disposed = true;
    });
    await flushMicrotasks();
    assert.equal(disposed, false);

    sendDeferred.resolve({ devicesNotified: 1, retryableFailures: 0 });
    await flushMicrotasks();
    assert.equal(disposed, false);
    assert.equal(repo.markCalls.length, 1);

    markerDeferred.resolve(true);
    const [result] = await Promise.all([first, second, disposing]);
    assert.equal(disposed, true);
    assert.equal(notification.sendCalls.length, 1);
    assert.equal(result.reminders[ActivationReminderKind.Bridge1].sent, 1);
  });

  it("makes an equal-deadline activation timeout fail coordinated shutdown without closing MongoDB", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(console, "error", () => {});
    const sendDeferred = createDeferred<NotificationDeliveryResult>();
    const repo = createRepo({
      due: { [ActivationReminderKind.Bridge1]: [candidate("stuck-user"), candidate("queued-user")] },
    });
    const notification = createNotification({
      send: async (_userId, _payload, abortSignal) => {
        const result = await sendDeferred.promise;
        abortSignal?.throwIfAborted();
        return result;
      },
    });
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: DEFAULT_OPTIONS,
    });

    const sweep = service.sweepOnce(NOW);
    await flushMicrotasks();
    const events: string[] = [];
    const exits: number[] = [];
    const coordinator = createShutdownCoordinator({
      app: {
        close: async () => {
          events.push("app.close");
        },
        closeAllConnections: () => events.push("app.force"),
      },
      bridgeStateTracker: {
        dispose: async () => {
          events.push("bridge.dispose");
        },
        forceFence: () => events.push("bridge.force"),
      },
      activationReminderService: service,
      dbConnector: {
        close: async () => {
          events.push("db.close");
        },
      },
      selectExit: (code) => exits.push(code),
    });
    const shutdown = coordinator.shutdown("SIGTERM");
    const disposing = service.dispose();
    assert.equal(service.dispose(), disposing);
    t.mock.timers.tick(ACTIVATION_REMINDER_DISPOSE_TIMEOUT_MS);
    await assert.rejects(disposing, /ActivationReminderDrainFenced/);
    await flushMicrotasks();
    service.forceFence();

    assert.equal(repo.markCalls.length, 0);
    assert.equal(notification.sendCalls[0]?.abortSignal?.aborted, true);
    assert.equal(events.includes("db.close"), false);
    assert.deepEqual(exits, []);
    assert.equal(
      warnCalls.filter(
        (args) => args[0] === "[ActivationReminderService] Disposal timed out with reminder delivery still in flight",
      ).length,
      1,
    );

    t.mock.timers.tick(SHUTDOWN_HARD_DEADLINE_MS - ACTIVATION_REMINDER_DISPOSE_TIMEOUT_MS);
    assert.equal(await shutdown, 1);
    assert.deepEqual(exits, [1]);
    assert.equal(events.includes("db.close"), false);

    sendDeferred.resolve({ devicesNotified: 1, retryableFailures: 0 });
    const result = await sweep;
    assert.equal(repo.markCalls.length, 0);
    assert.equal(notification.sendCalls.length, 1);
    assert.equal(result.reminders[ActivationReminderKind.Bridge1].failed, 1);
    assert.equal(
      warnCalls.some((args) => args[0] === "[ActivationReminderService] Reminder failed and remains retryable"),
      false,
    );
  });

  it("allows an already-dispatched marker to settle after fencing without starting the next candidate", async () => {
    const markerDeferred = createDeferred<boolean>();
    const repo = createRepo({
      due: { [ActivationReminderKind.Bridge1]: [candidate("marking-user"), candidate("queued-user")] },
      mark: async () => markerDeferred.promise,
    });
    const notification = createNotification();
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: DEFAULT_OPTIONS,
    });

    const sweep = service.sweepOnce(NOW);
    await flushMicrotasks();
    assert.equal(repo.markCalls.length, 1);

    const disposing = service.dispose();
    service.forceFence();
    service.forceFence();
    await assert.rejects(disposing, /ActivationReminderDrainFenced/);

    markerDeferred.resolve(true);
    const result = await sweep;

    assert.equal(notification.sendCalls.length, 1);
    assert.equal(repo.markCalls.length, 1);
    assert.equal(result.reminders[ActivationReminderKind.Bridge1].sent, 0);
    assert.equal(result.reminders[ActivationReminderKind.Bridge1].failed, 1);
    assert.equal(
      warnCalls.some((args) => args[0] === "[ActivationReminderService] Reminder failed and remains retryable"),
      false,
    );
  });

  it("starts only when enabled and stops interval sweeps on dispose", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const repo = createRepo();
    const notification = createNotification();
    const enabled = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: DEFAULT_OPTIONS,
    });
    const disabled = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: { ...DEFAULT_OPTIONS, enabled: false },
    });

    enabled.start();
    enabled.start();
    disabled.start();
    t.mock.timers.tick(DEFAULT_OPTIONS.sweepIntervalMs);
    await flushMicrotasks();
    assert.equal(repo.findCalls.length, 3);

    await enabled.dispose();
    await enabled.dispose();
    t.mock.timers.tick(DEFAULT_OPTIONS.sweepIntervalMs);
    await flushMicrotasks();
    assert.equal(repo.findCalls.length, 3);
  });
});

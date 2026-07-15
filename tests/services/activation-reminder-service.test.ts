import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type {
  ActivationReminderKind,
  ActivationStateRepository,
  DueActivationReminder,
} from "../../src/repositories/activation-state-repo.js";
import {
  ActivationReminderService,
  type ActivationReminderServiceOptions,
} from "../../src/services/activation-reminder-service.js";
import type {
  NotificationDeliveryResult,
  NotificationPayload,
  NotificationService,
} from "../../src/services/notification-service.js";

type SendCall = { userId: string; payload: NotificationPayload };
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
  return { bridge_1: [], bridge_2: [], session: [] };
}

function createRepo(args?: {
  due?: Partial<Record<ActivationReminderKind, DueActivationReminder[]>>;
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
  send?: (userId: string, payload: NotificationPayload) => Promise<NotificationDeliveryResult>;
}) {
  const sendCalls: SendCall[] = [];
  const service = {
    isAvailable: args?.available ?? true,
    sendToUser: async (userId: string, payload: NotificationPayload) => {
      sendCalls.push({ userId, payload });
      return args?.send?.(userId, payload) ?? { devicesNotified: 1, retryableFailures: 0 };
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
  beforeEach(() => {
    mock.method(console, "log", () => {});
    mock.method(console, "warn", () => {});
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("sends approved payloads with distinct collapse keys and marks zero-device sends", async () => {
    const repo = createRepo({
      due: {
        bridge_1: [candidate("bridge-1-user")],
        bridge_2: [candidate("bridge-2-user")],
        session: [candidate("session-user")],
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

    assert.equal(result.status, "completed");
    assert.deepEqual(
      notification.sendCalls.map((call) => ({
        userId: call.userId,
        category: call.payload.category,
        title: call.payload.title,
        collapseKey: call.payload.collapseKey,
      })),
      [
        {
          userId: "bridge-1-user",
          category: "system_update",
          title: "Finish setting up Sesori",
          collapseKey: "activation_bridge_1",
        },
        {
          userId: "bridge-2-user",
          category: "system_update",
          title: "Your Sesori setup is unfinished",
          collapseKey: "activation_bridge_2",
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
    assert.equal(result.reminders.session.sent, 1);
    assert.equal(result.reminders.session.noDevices, 1);
  });

  it("limits each reminder kind to its configured batch size", async () => {
    const repo = createRepo({
      due: {
        bridge_1: [candidate("user-1"), candidate("user-2"), candidate("user-3")],
      },
    });
    const notification = createNotification();
    const service = new ActivationReminderService({
      activationStateRepo: repo.repo,
      notificationService: notification.service,
      options: { ...DEFAULT_OPTIONS, batchLimit: 2 },
    });

    const result = await service.sweepOnce(NOW);

    assert.equal(result.reminders.bridge_1.due, 2);
    assert.equal(notification.sendCalls.length, 2);
    assert.ok(repo.findCalls.every((call) => call.batchLimit === 2));
  });

  it("does nothing when disabled or when FCM is unavailable", async () => {
    const repo = createRepo({ due: { bridge_1: [candidate("user-1")] } });
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

    assert.equal((await unavailable.sweepOnce(NOW)).status, "unavailable");
    assert.equal((await disabled.sweepOnce(NOW)).status, "disabled");
    assert.equal(repo.findCalls.length, 0);
    assert.equal(notification.sendCalls.length, 0);
    assert.equal(repo.markCalls.length, 0);
  });

  it("rechecks eligibility immediately before sending", async () => {
    const repo = createRepo({
      due: { bridge_1: [candidate("completed-user")] },
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
    assert.equal(result.reminders.bridge_1.skipped, 1);
  });

  it("leaves thrown sends retryable and succeeds on a later sweep", async () => {
    const repo = createRepo({ due: { bridge_1: [candidate("retry-user")] } });
    let attempts = 0;
    const notification = createNotification({
      send: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("FCM unavailable");
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

    assert.equal(first.reminders.bridge_1.failed, 1);
    assert.equal(second.reminders.bridge_1.sent, 1);
    assert.equal(repo.markCalls.length, 1);
  });

  it("does not mark a stage that completes while the notification is sending", async () => {
    const repo = createRepo({
      due: { session: [candidate("racing-user")] },
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
    assert.equal(result.reminders.session.sent, 0);
    assert.equal(result.reminders.session.skipped, 1);
  });

  it("leaves all-transient token failures retryable and succeeds on a later sweep", async () => {
    const repo = createRepo({ due: { bridge_1: [candidate("transient-user")] } });
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

    assert.equal(first.reminders.bridge_1.failed, 1);
    assert.equal(second.reminders.bridge_1.sent, 1);
    assert.equal(repo.markCalls.length, 1);
  });

  it("leaves a successful send retryable when the conditional marker write fails", async () => {
    let markAttempts = 0;
    const repo = createRepo({
      due: { session: [candidate("marker-failure-user")] },
      mark: () => {
        markAttempts += 1;
        if (markAttempts === 1) throw new Error("MongoDB unavailable");
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

    assert.equal(first.reminders.session.failed, 1);
    assert.equal(second.reminders.session.sent, 1);
    assert.equal(notification.sendCalls.length, 2);
  });

  it("coalesces concurrent sweeps and dispose drains only the current reminder through its marker", async () => {
    const sendDeferred = createDeferred<NotificationDeliveryResult>();
    const markerDeferred = createDeferred<boolean>();
    const repo = createRepo({
      due: { bridge_1: [candidate("slow-user"), candidate("queued-user")] },
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
    assert.equal(result.reminders.bridge_1.sent, 1);
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

import { BridgeConnectionNotificationPolicy, BridgeStatus } from "../models/bridge.js";
import { NotificationCategory } from "../models/notification.js";
import type { ConnectionStatusNotificationPayload, NotificationService } from "./notification-service.js";

const DEFAULT_BRIDGE_NOTIFICATION_DEBOUNCE_MS = 120_000;
const DEFAULT_NORMAL_WAKE_ONLINE_DELAY_MS = 5_000;
const BRIDGE_STATE_TRACKER_DISPOSE_TIMEOUT_MS = 15_000;

type PendingNotification = {
  status: BridgeStatus;
  connectionId: string | null;
  policy: BridgeConnectionNotificationPolicy;
  excludedDeviceIds: Set<string>;
  timer: ReturnType<typeof setTimeout>;
  generation: number;
};

type EarlyConnectionObservation = {
  connectionId: string;
  deviceIds: Set<string>;
};

type BridgeStateEntry = {
  pending: PendingNotification | null;
  earlyConnectionObservation: EarlyConnectionObservation | null;
  lastNotifiedStatus: BridgeStatus | null;
  generation: number;
};

function instanceKey(args: { userId: string; bridgeId: string }): string {
  return `${args.userId}::${args.bridgeId}`;
}

export class BridgeStateTracker {
  readonly #notificationService: NotificationService;
  readonly #conservativeDelayMs: number;
  readonly #normalOnlineDelayMs: number;
  readonly #state = new Map<string, BridgeStateEntry>();
  readonly #inFlight = new Set<Promise<void>>();
  #accepting = true;
  #disposePromise: Promise<void> | null = null;

  constructor(args: {
    notificationService: NotificationService;
    conservativeDelayMs?: number;
    normalOnlineDelayMs?: number;
  }) {
    this.#notificationService = args.notificationService;
    this.#conservativeDelayMs = args.conservativeDelayMs ?? DEFAULT_BRIDGE_NOTIFICATION_DEBOUNCE_MS;
    this.#normalOnlineDelayMs = args.normalOnlineDelayMs ?? DEFAULT_NORMAL_WAKE_ONLINE_DELAY_MS;
  }

  handleStatusChangeForBridge(args: {
    userId: string;
    bridgeId: string;
    status: BridgeStatus;
    notificationPolicy: BridgeConnectionNotificationPolicy;
    connectionId: string | null;
  }): void {
    if (!this.#accepting) {
      return;
    }

    const key = instanceKey(args);
    const entry = this.#getOrCreateEntry(key);

    if (args.notificationPolicy === BridgeConnectionNotificationPolicy.Suppress) {
      if (entry.pending?.status === BridgeStatus.active) {
        this.#cancelPending(entry);
      }
      return;
    }

    if (args.status === BridgeStatus.active && entry.pending?.status === BridgeStatus.inactive) {
      this.#cancelPending(entry);
    }

    if (entry.lastNotifiedStatus === args.status && entry.pending === null) {
      return;
    }

    const delay =
      args.status === BridgeStatus.active && args.notificationPolicy === BridgeConnectionNotificationPolicy.Normal
        ? this.#normalOnlineDelayMs
        : this.#conservativeDelayMs;
    if (
      entry.pending?.status === args.status &&
      entry.pending.connectionId === args.connectionId &&
      (entry.pending.policy === BridgeConnectionNotificationPolicy.Normal ||
        args.notificationPolicy !== BridgeConnectionNotificationPolicy.Normal)
    ) {
      return;
    }
    this.#schedule({
      entry,
      userId: args.userId,
      status: args.status,
      connectionId: args.connectionId,
      policy: args.notificationPolicy,
      delay,
    });
  }

  markConnectionObserved(args: { userId: string; bridgeId: string; connectionId: string; deviceId: string }): void {
    if (!this.#accepting) {
      return;
    }

    const entry = this.#getOrCreateEntry(instanceKey(args));
    const pending = entry.pending;
    if (pending?.status === BridgeStatus.active && pending.connectionId === args.connectionId) {
      pending.excludedDeviceIds.add(args.deviceId);
      return;
    }

    if (entry.earlyConnectionObservation?.connectionId !== args.connectionId) {
      entry.earlyConnectionObservation = { connectionId: args.connectionId, deviceIds: new Set<string>() };
    }
    entry.earlyConnectionObservation.deviceIds.add(args.deviceId);
  }

  cancelPendingForBridge(userId: string, bridgeId: string): void {
    if (!this.#accepting) {
      return;
    }

    const key = instanceKey({ userId, bridgeId });
    const entry = this.#state.get(key);
    if (!entry) {
      return;
    }
    this.#cancelPending(entry);
    this.#state.delete(key);
  }

  #schedule(args: {
    entry: BridgeStateEntry;
    userId: string;
    status: BridgeStatus;
    connectionId: string | null;
    policy: BridgeConnectionNotificationPolicy;
    delay: number;
  }): void {
    const previousPending = args.entry.pending;
    this.#cancelPending(args.entry);
    args.entry.generation += 1;
    const generation = args.entry.generation;
    const earlyObservation = args.entry.earlyConnectionObservation;
    const excludedDeviceIds =
      args.status === BridgeStatus.active &&
      previousPending?.status === BridgeStatus.active &&
      previousPending.connectionId === args.connectionId
        ? previousPending.excludedDeviceIds
        : new Set<string>();
    if (args.status === BridgeStatus.active && earlyObservation?.connectionId === args.connectionId) {
      for (const deviceId of earlyObservation.deviceIds) {
        excludedDeviceIds.add(deviceId);
      }
      args.entry.earlyConnectionObservation = null;
    }
    const pending: PendingNotification = {
      status: args.status,
      connectionId: args.connectionId,
      policy: args.policy,
      excludedDeviceIds,
      generation,
      timer: setTimeout(() => {
        if (args.entry.pending !== pending || pending.generation !== generation) {
          return;
        }
        const callback = this.#send({ entry: args.entry, pending, userId: args.userId });
        this.#inFlight.add(callback);
        void callback.finally(() => this.#inFlight.delete(callback));
      }, args.delay),
    };
    pending.timer.unref?.();
    args.entry.pending = pending;
  }

  async #send(args: { entry: BridgeStateEntry; pending: PendingNotification; userId: string }): Promise<void> {
    try {
      await this.#notificationService.sendToUser(
        args.userId,
        this.#buildPayload(args.pending.status, args.pending.excludedDeviceIds),
      );
    } catch (err) {
      console.warn("Bridge notification failed", { userId: args.userId, status: args.pending.status, err });
    } finally {
      if (args.entry.pending === args.pending) {
        args.entry.lastNotifiedStatus = args.pending.status;
        args.entry.pending = null;
      }
    }
  }

  #cancelPending(entry: BridgeStateEntry): void {
    if (!entry.pending) {
      return;
    }
    clearTimeout(entry.pending.timer);
    entry.pending = null;
    entry.generation += 1;
  }

  dispose(): Promise<void> {
    this.#accepting = false;
    this.#disposePromise ??= this.#disposeOnce();
    return this.#disposePromise;
  }

  async #disposeOnce(): Promise<void> {
    for (const entry of this.#state.values()) {
      this.#cancelPending(entry);
    }
    this.#state.clear();
    const callbacks = Array.from(this.#inFlight);
    if (callbacks.length === 0) {
      return;
    }
    await withDisposeTimeout(Promise.allSettled(callbacks).then(() => undefined));
    if (this.#inFlight.size > 0) {
      throw new BridgeStateTrackerDrainTimeout();
    }
  }

  #getOrCreateEntry(key: string): BridgeStateEntry {
    const existing = this.#state.get(key);
    if (existing) {
      return existing;
    }
    const entry: BridgeStateEntry = {
      pending: null,
      earlyConnectionObservation: null,
      lastNotifiedStatus: null,
      generation: 0,
    };
    this.#state.set(key, entry);
    return entry;
  }

  #buildPayload(status: BridgeStatus, excludedDeviceIds: ReadonlySet<string>): ConnectionStatusNotificationPayload {
    return status === BridgeStatus.active
      ? {
          category: NotificationCategory.ConnectionStatus,
          title: "Bridge Online",
          body: "Your bridge has reconnected.",
          collapseKey: "connection_status",
          excludedDeviceIds,
        }
      : {
          category: NotificationCategory.ConnectionStatus,
          title: "Bridge Offline",
          body: "Your bridge has disconnected. AI sessions are paused.",
          collapseKey: "connection_status",
          excludedDeviceIds,
        };
  }
}

export class BridgeStateTrackerDrainTimeout extends Error {
  constructor() {
    super("bridge state tracker drain timed out");
    this.name = "BridgeStateTrackerDrainTimeout";
  }
}

async function withDisposeTimeout(promise: Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new BridgeStateTrackerDrainTimeout()),
      BRIDGE_STATE_TRACKER_DISPOSE_TIMEOUT_MS,
    );
    timeout.unref?.();
    promise.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

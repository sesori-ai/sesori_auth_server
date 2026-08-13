import { BridgeStatus } from "../models/bridge.js";
import type { NotificationPayload, NotificationService } from "./notification-service.js";
import { NotificationCategory } from "../models/notification.js";

/**
 * Debounces bridge online/offline push notifications so transient relay
 * reconnects don't spam the user. State is keyed by (userId, bridgeId) so
 * each registered bridge is debounced independently.
 *
 * State is in-process and unbounded: entries accrue per (userId, bridgeId)
 * for the process lifetime (the last-notified status is kept for dedupe).
 * That is acceptable for the current single-instance deployment with a
 * per-user bridge cap; see AGENTS.md "SCALING CONSTRAINTS" before reusing
 * this in a multi-instance topology — timers also do not survive restarts.
 */
// 120s: long enough to swallow relay restarts and flapping reconnects,
// short enough that a real offline event still notifies promptly.
const DEFAULT_BRIDGE_NOTIFICATION_DEBOUNCE_MS = 120_000;
const BRIDGE_STATE_TRACKER_DISPOSE_TIMEOUT_MS = 15_000;

type BridgeStateEntry = {
  pendingStatus: BridgeStatus | null;
  lastNotifiedStatus: BridgeStatus | null;
  timer: ReturnType<typeof setTimeout> | null;
  generation: number;
};

function instanceKey(userId: string, bridgeId: string): string {
  return `${userId}::${bridgeId}`;
}

export class BridgeStateTracker {
  readonly #notificationService: NotificationService;
  readonly #debounceMs: number;
  readonly #state = new Map<string, BridgeStateEntry>();
  readonly #inFlight = new Set<Promise<void>>();
  #accepting = true;
  #disposePromise: Promise<void> | null = null;

  constructor(notificationService: NotificationService, debounceMs: number = DEFAULT_BRIDGE_NOTIFICATION_DEBOUNCE_MS) {
    this.#notificationService = notificationService;
    this.#debounceMs = debounceMs;
  }

  handleStatusChangeForBridge(userId: string, bridgeId: string, status: BridgeStatus): void {
    if (!this.#accepting) {
      return;
    }

    this.#dispatch(userId, instanceKey(userId, bridgeId), status);
  }

  cancelPendingForBridge(userId: string, bridgeId: string): void {
    if (!this.#accepting) {
      return;
    }

    const key = instanceKey(userId, bridgeId);
    this.#cancelPendingForKey(key);
  }

  // Deliberate "forget everything" semantics: deleting the entry also drops
  // lastNotifiedStatus, so a bridge that is revoked and later re-registered
  // under the same bridgeId is treated as brand new and may re-notify a
  // status that was already pushed before the cancel. That is acceptable —
  // a re-registered bridge is a new bridge from the user's perspective —
  // and it keeps cancellation the only place entries are removed, bounding
  // the map by active (not historical) keys.
  #cancelPendingForKey(key: string): void {
    const entry = this.#state.get(key);
    if (!entry) {
      return;
    }

    entry.generation += 1;
    entry.pendingStatus = null;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.#state.delete(key);
  }

  #dispatch(userId: string, key: string, status: BridgeStatus): void {
    const entry = this.#getOrCreateEntry(key);

    if (status === entry.pendingStatus) {
      return;
    }

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
      entry.pendingStatus = null;
    }

    if (status === entry.lastNotifiedStatus) {
      return;
    }

    entry.generation += 1;
    const capturedGeneration = entry.generation;
    entry.pendingStatus = status;
    entry.timer = setTimeout(() => {
      if (entry.generation !== capturedGeneration) {
        return;
      }

      const callback = this.#runCallback({ entry, capturedGeneration, userId, status });
      this.#inFlight.add(callback);
      void callback.finally(() => {
        this.#inFlight.delete(callback);
      });
    }, this.#debounceMs);
    // A pending debounce must not keep the process alive on shutdown
    // (dispose() is not on every exit path). Optional call: the mocked
    // timers used in tests do not implement unref.
    entry.timer.unref?.();
  }

  async #runCallback(args: {
    readonly entry: BridgeStateEntry;
    readonly capturedGeneration: number;
    readonly userId: string;
    readonly status: BridgeStatus;
  }): Promise<void> {
    const { entry, capturedGeneration, userId, status } = args;
    try {
      if (!this.#accepting) {
        return;
      }

      try {
        await this.#notificationService.sendToUser(userId, this.#buildPayload(status));
      } catch (err) {
        console.warn("Bridge notification failed", { userId, status, err });
      } finally {
        if (entry.generation === capturedGeneration) {
          entry.lastNotifiedStatus = status;
          entry.pendingStatus = null;
          entry.timer = null;
        }
      }
    } finally {
      if (!this.#accepting) {
        this.#state.clear();
      }
    }
  }

  dispose(): Promise<void> {
    this.#accepting = false;
    this.#disposePromise ??= this.#disposeOnce();
    return this.#disposePromise;
  }

  async #disposeOnce(): Promise<void> {
    for (const entry of this.#state.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
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
    const existingEntry = this.#state.get(key);
    if (existingEntry) {
      return existingEntry;
    }

    const entry: BridgeStateEntry = {
      pendingStatus: null,
      lastNotifiedStatus: null,
      timer: null,
      generation: 0,
    };
    this.#state.set(key, entry);
    return entry;
  }

  #buildPayload(status: BridgeStatus): NotificationPayload {
    if (status === BridgeStatus.active) {
      return {
        category: NotificationCategory.ConnectionStatus,
        title: "Bridge Online",
        body: "Your bridge has reconnected.",
        collapseKey: "connection_status",
      };
    }

    return {
      category: NotificationCategory.ConnectionStatus,
      title: "Bridge Offline",
      body: "Your bridge has disconnected. AI sessions are paused.",
      collapseKey: "connection_status",
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

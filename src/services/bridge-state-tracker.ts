import { BridgeStatus } from "../models/bridge.js";
import type { NotificationPayload, NotificationService } from "./notification-service.js";

/**
 * Debounces bridge online/offline push notifications so transient relay
 * reconnects don't spam the user. Two keying modes coexist during the
 * per-bridge rollout:
 *   - instanceKey(userId, bridgeId): used when the relay reports a bridgeId
 *     (updated bridge clients)
 *   - legacyKey(userId): user-level, used when the relay omits the bridgeId
 *     (bridge clients that have not updated yet)
 * The legacy mode can be removed once AUTH_REQUIRE_BRIDGE_ID_IN_STATUS=true
 * is rolled out everywhere (auth-server + relay + bridge fleet).
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

type BridgeStateEntry = {
  pendingStatus: BridgeStatus | null;
  lastNotifiedStatus: BridgeStatus | null;
  timer: ReturnType<typeof setTimeout> | null;
  generation: number;
};

const LEGACY_KEY_SUFFIX = "::legacy";

function instanceKey(userId: string, bridgeId: string): string {
  return `${userId}::${bridgeId}`;
}

function legacyKey(userId: string): string {
  return `${userId}${LEGACY_KEY_SUFFIX}`;
}

export class BridgeStateTracker {
  readonly #notificationService: NotificationService;
  readonly #debounceMs: number;
  readonly #state = new Map<string, BridgeStateEntry>();

  constructor(notificationService: NotificationService, debounceMs: number = DEFAULT_BRIDGE_NOTIFICATION_DEBOUNCE_MS) {
    this.#notificationService = notificationService;
    this.#debounceMs = debounceMs;
  }

  handleStatusChange(userId: string, status: BridgeStatus): void {
    this.#dispatch(userId, legacyKey(userId), status);
  }

  handleStatusChangeForBridge(userId: string, bridgeId: string, status: BridgeStatus): void {
    this.#dispatch(userId, instanceKey(userId, bridgeId), status);
  }

  cancelPendingForBridge(userId: string, bridgeId: string): void {
    const key = instanceKey(userId, bridgeId);
    this.#cancelPendingForKey(key);
  }

  cancelPendingForUser(userId: string): void {
    this.#cancelPendingForKey(legacyKey(userId));
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
    entry.timer = setTimeout(async () => {
      if (entry.generation !== capturedGeneration) {
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
    }, this.#debounceMs);
    // A pending debounce must not keep the process alive on shutdown
    // (dispose() is not on every exit path). Optional call: the mocked
    // timers used in tests do not implement unref.
    entry.timer.unref?.();
  }

  dispose(): void {
    for (const entry of this.#state.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }

    this.#state.clear();
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
        category: "connection_status",
        title: "Bridge Online",
        body: "Your bridge has reconnected.",
        collapseKey: "connection_status",
      };
    }

    return {
      category: "connection_status",
      title: "Bridge Offline",
      body: "Your bridge has disconnected. AI sessions are paused.",
      collapseKey: "connection_status",
    };
  }
}

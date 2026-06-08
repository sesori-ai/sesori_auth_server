import type { NotificationPayload, NotificationService } from "./notification-service.js";

type BridgeStatus = "active" | "inactive";

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
    if (status === "active") {
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

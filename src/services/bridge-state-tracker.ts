import type { BridgeStatusBody } from "../models/api.js";
import type { NotificationPayload, NotificationService } from "./notification-service.js";

type BridgeStatus = BridgeStatusBody["status"];

type BridgeStateEntry = {
  pendingStatus: BridgeStatus | null;
  lastNotifiedStatus: BridgeStatus | null;
  timer: ReturnType<typeof setTimeout> | null;
  generation: number;
};

export class BridgeStateTracker {
  readonly #notificationService: NotificationService;
  readonly #debounceMs: number;
  readonly #state = new Map<string, BridgeStateEntry>();

  constructor(notificationService: NotificationService, debounceMs: number = 60_000) {
    this.#notificationService = notificationService;
    this.#debounceMs = debounceMs;
  }

  handleStatusChange(userId: string, status: BridgeStatus): void {
    const entry = this.#getOrCreateEntry(userId);

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

  #getOrCreateEntry(userId: string): BridgeStateEntry {
    const existingEntry = this.#state.get(userId);
    if (existingEntry) {
      return existingEntry;
    }

    const entry: BridgeStateEntry = {
      pendingStatus: null,
      lastNotifiedStatus: null,
      timer: null,
      generation: 0,
    };
    this.#state.set(userId, entry);
    return entry;
  }

  #buildPayload(status: BridgeStatus): NotificationPayload {
    if (status === "connected") {
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

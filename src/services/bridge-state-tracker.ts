import { BridgeStatus } from "../models/bridge.js";
import { safeErrorType } from "../lib/errors.js";
import type { NotificationPayload, NotificationService } from "./notification-service.js";

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
  readonly #lifecycleAbortController = new AbortController();
  readonly #inFlight = new Set<Promise<void>>();
  #disposePromise: Promise<void> | null = null;
  #disposed = false;

  constructor(notificationService: NotificationService, debounceMs: number = DEFAULT_BRIDGE_NOTIFICATION_DEBOUNCE_MS) {
    this.#notificationService = notificationService;
    this.#debounceMs = debounceMs;
  }

  handleStatusChangeForBridge(userId: string, bridgeId: string, status: BridgeStatus): void {
    if (this.#disposed) {
      return;
    }

    this.#dispatch(userId, instanceKey(userId, bridgeId), status);
  }

  cancelPendingForBridge(userId: string, bridgeId: string): void {
    if (this.#disposed) {
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
    if (this.#disposed) {
      return;
    }

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
      const callback = this.#notify(userId, key, entry, status, capturedGeneration);
      this.#inFlight.add(callback);
      void callback.then(
        () => this.#inFlight.delete(callback),
        () => this.#inFlight.delete(callback),
      );
    }, this.#debounceMs);
    // A pending debounce must not keep the process alive on shutdown
    // (dispose() is not on every exit path). Optional call: the mocked
    // timers used in tests do not implement unref.
    entry.timer.unref?.();
  }

  async #notify(
    userId: string,
    key: string,
    entry: BridgeStateEntry,
    status: BridgeStatus,
    capturedGeneration: number,
  ): Promise<void> {
    if (!this.#isCurrent(key, entry, capturedGeneration)) {
      return;
    }

    try {
      await this.#notificationService.sendToUser(
        userId,
        this.#buildPayload(status),
        this.#lifecycleAbortController.signal,
      );
    } catch (error) {
      if (!this.#lifecycleAbortController.signal.aborted) {
        console.warn("Bridge notification failed", { status, errorType: safeErrorType({ error }) });
      }
    }

    if (!this.#isCurrent(key, entry, capturedGeneration)) {
      return;
    }

    entry.lastNotifiedStatus = status;
    entry.pendingStatus = null;
    entry.timer = null;
  }

  /**
   * Stops new work, aborts in-flight notification stages, and waits for every
   * callback to settle. Notification failures are absorbed by `#notify`; the
   * shutdown coordinator provides the hard bound for a transport that ignores
   * abort and never settles.
   */
  dispose(): Promise<void> {
    this.#stop();

    if (!this.#disposePromise) {
      this.#disposePromise = Promise.all(this.#inFlight).then(() => undefined);
    }

    return this.#disposePromise;
  }

  /**
   * Reasserts the synchronous stop/abort fence. It deliberately does not make
   * `dispose()` resolve while a callback is still retained.
   */
  forceFence(): void {
    this.#stop();
  }

  #stop(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    for (const entry of this.#state.values()) {
      entry.generation += 1;
      entry.pendingStatus = null;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    }

    this.#state.clear();
    this.#lifecycleAbortController.abort();
  }

  #isCurrent(key: string, entry: BridgeStateEntry, capturedGeneration: number): boolean {
    return !this.#disposed && entry.generation === capturedGeneration && this.#state.get(key) === entry;
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

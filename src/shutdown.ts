import { safeErrorType } from "./lib/errors.js";
import type { MongoDbConnector } from "./db/mongo-db-connector.js";
import type { ActivationReminderService } from "./services/activation-reminder-service.js";
import type { BridgeStateTracker } from "./services/bridge-state-tracker.js";

export const SHUTDOWN_DRAIN_DEADLINE_MS = 15_000;
export const SHUTDOWN_HARD_DEADLINE_MS = 22_000;
export const SHUTDOWN_IDLE_REAP_INTERVAL_MS = 250;

export type ShutdownSignal = "SIGINT" | "SIGTERM";
export type ShutdownExitCode = 0 | 1;

export type ShutdownApp = {
  close: () => Promise<void>;
  closeAllConnections: () => void;
  closeIdleConnections: () => void;
};
type TimeoutHandle = { unref?: () => unknown };

export type ShutdownTimers = {
  setTimeout: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearTimeout: (handle: TimeoutHandle) => void;
};

export type ShutdownTiming = {
  startedAt?: number;
  now?: () => number;
  timers?: ShutdownTimers;
};

export type ShutdownCoordinator = {
  shutdown: (signal: ShutdownSignal) => Promise<ShutdownExitCode>;
};

export type ShutdownRequestWaiters = {
  releaseWaiters: () => void;
  drainReleasedReads: () => Promise<void>;
};

export type ShutdownCoordinatorDependencies = ShutdownTiming & {
  app: ShutdownApp;
  requestWaiters?: ShutdownRequestWaiters[];
  activationReminderService: Pick<ActivationReminderService, "dispose" | "forceFence">;
  bridgeStateTracker: Pick<BridgeStateTracker, "dispose" | "forceFence">;
  dbConnector: Pick<MongoDbConnector, "close">;
  selectExit: (code: ShutdownExitCode) => void;
};

export type PartialStartupResources = {
  app?: (Pick<ShutdownApp, "close"> & Partial<Pick<ShutdownApp, "closeAllConnections">>) | null;
  requestWaiters?: ShutdownRequestWaiters[];
  activationReminderService?: Pick<ActivationReminderService, "dispose" | "forceFence"> | null;
  bridgeStateTracker?: Pick<BridgeStateTracker, "dispose" | "forceFence"> | null;
  dbConnector?: Pick<MongoDbConnector, "close"> | null;
};

type ShutdownOperation = () => void | Promise<void>;
type ShutdownStage = readonly [stage: string, operation: ShutdownOperation];
type BoundedShutdownOptions = ShutdownTiming & {
  stages: ShutdownStage[];
  forceFence: () => void;
  closeDatabase?: () => Promise<void>;
  reapIdle?: () => void;
  onHardDeadline?: () => void;
  logFailure: (stage: string, error: unknown) => void;
};

export const defaultShutdownTimers: ShutdownTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function remainingShutdownMs(startedAt: number, deadlineMs: number, now: () => number): number {
  return Math.max(0, startedAt + deadlineMs - now());
}

const createFailureLogger =
  (prefix: string) =>
  (stage: string, error: unknown): void => {
    console.error(prefix, { stage, errorType: safeErrorType({ error }) });
  };

export function createExitSelector(
  selectExit: (code: ShutdownExitCode) => void,
): (code: ShutdownExitCode) => ShutdownExitCode {
  let selected: ShutdownExitCode | null = null;
  const logFailure = createFailureLogger("[Shutdown] Stage failed");
  return (code) => {
    if (selected === null) {
      selected = code;
      try {
        selectExit(code);
      } catch (error) {
        logFailure("exit_selection", error);
      }
    }
    return selected;
  };
}

function runSafely(logFailure: BoundedShutdownOptions["logFailure"], stage: string, operation: () => void): void {
  try {
    operation();
  } catch (error) {
    logFailure(stage, error);
  }
}

async function settleStage(
  [stage, operation]: ShutdownStage,
  logFailure: BoundedShutdownOptions["logFailure"],
  onFailure: () => void,
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    logFailure(stage, error);
    onFailure();
    return false;
  }
}

async function runBoundedShutdown(options: BoundedShutdownOptions): Promise<ShutdownExitCode> {
  const timers = options.timers ?? defaultShutdownTimers;
  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? now();
  const forceFence = (): void => runSafely(options.logFailure, "force_fence", options.forceFence);
  const reachHardDeadline = (): void => {
    forceFence();
    options.onHardDeadline?.();
  };

  if (remainingShutdownMs(startedAt, SHUTDOWN_HARD_DEADLINE_MS, now) === 0) {
    reachHardDeadline();
    return 1;
  }

  let resolveHardDeadline!: (result: false) => void;
  const hardDeadline = new Promise<false>((resolve) => {
    resolveHardDeadline = resolve;
  });
  const hardTimer = timers.setTimeout(
    () => {
      reachHardDeadline();
      resolveHardDeadline(false);
    },
    remainingShutdownMs(startedAt, SHUTDOWN_HARD_DEADLINE_MS, now),
  );

  const outcomes = Promise.all(options.stages.map((stage) => settleStage(stage, options.logFailure, forceFence)));

  let reapTimer: TimeoutHandle | null = null;
  let reaping = options.reapIdle !== undefined;
  const reap = (): void => {
    if (!reaping || !options.reapIdle) {
      return;
    }
    runSafely(options.logFailure, "fastify_reap_idle", options.reapIdle);
    reapTimer = timers.setTimeout(reap, SHUTDOWN_IDLE_REAP_INTERVAL_MS);
    reapTimer.unref?.();
  };
  if (reaping) {
    reapTimer = timers.setTimeout(reap, SHUTDOWN_IDLE_REAP_INTERVAL_MS);
    reapTimer.unref?.();
  }

  const drainDelay = remainingShutdownMs(startedAt, SHUTDOWN_DRAIN_DEADLINE_MS, now);
  let drainTimer: TimeoutHandle | null = null;
  const drainDeadline = new Promise<void>((resolve) => {
    if (drainDelay === 0) {
      resolve();
    } else {
      drainTimer = timers.setTimeout(resolve, drainDelay);
      drainTimer.unref?.();
    }
  });
  const first = await Promise.race([outcomes, drainDeadline.then(() => null), hardDeadline]);
  if (drainTimer) {
    timers.clearTimeout(drainTimer);
  }
  reaping = false;
  if (reapTimer) {
    timers.clearTimeout(reapTimer);
  }

  if (first === false) {
    return 1;
  }

  if (!first || !first.every(Boolean)) {
    forceFence();
    const recovered = await Promise.race([outcomes.then((results) => results.every(Boolean)), hardDeadline]);
    if (!recovered) {
      await hardDeadline;
      return 1;
    }
  }

  if (remainingShutdownMs(startedAt, SHUTDOWN_HARD_DEADLINE_MS, now) === 0) {
    timers.clearTimeout(hardTimer);
    reachHardDeadline();
    return 1;
  }

  if (!options.closeDatabase) {
    timers.clearTimeout(hardTimer);
    return 0;
  }

  const databaseResult = await Promise.race([
    settleStage(["mongodb_close", options.closeDatabase], options.logFailure, () => undefined),
    hardDeadline,
  ]);
  timers.clearTimeout(hardTimer);
  return databaseResult ? 0 : 1;
}

function forceResources(input: PartialStartupResources, logFailure: BoundedShutdownOptions["logFailure"]): void {
  for (const waiters of input.requestWaiters ?? []) {
    runSafely(logFailure, "request_waiter_release", waiters.releaseWaiters.bind(waiters));
  }
  runSafely(logFailure, "bridge_force_fence", () => input.bridgeStateTracker?.forceFence());
  runSafely(logFailure, "activation_force_fence", () => input.activationReminderService?.forceFence());
  runSafely(logFailure, "fastify_force_close", () => input.app?.closeAllConnections?.());
}

export function createShutdownCoordinator(deps: ShutdownCoordinatorDependencies): ShutdownCoordinator {
  let shutdownPromise: Promise<ShutdownExitCode> | null = null;
  const logFailure = createFailureLogger("[Shutdown] Stage failed");
  const selectExit = createExitSelector(deps.selectExit);

  const waiters = deps.requestWaiters ?? [];
  const stages: ShutdownStage[] = [
    ...waiters.map((waiter) => ["request_waiter_release", () => waiter.releaseWaiters()] as const),
    ["bridge_drain", () => deps.bridgeStateTracker.dispose()],
    ["activation_dispose", () => deps.activationReminderService.dispose()],
    [
      "request_waiter_drain",
      async () => void (await Promise.all(waiters.map((waiter) => waiter.drainReleasedReads()))),
    ],
    ["fastify_close", () => deps.app.close()],
  ];

  return {
    shutdown(signal) {
      if (!shutdownPromise) {
        if (deps.startedAt === undefined) {
          console.log("[Shutdown] Started", { signal });
        }
        shutdownPromise = runBoundedShutdown({
          ...deps,
          stages,
          forceFence: () => forceResources(deps, logFailure),
          closeDatabase: () => deps.dbConnector.close(),
          reapIdle: () => deps.app.closeIdleConnections(),
          onHardDeadline: () => selectExit(1),
          logFailure,
        }).then(selectExit);
      }
      return shutdownPromise;
    },
  };
}

export function forceFencePartialStartup(input: PartialStartupResources): void {
  forceResources(input, createFailureLogger("[StartupCleanup] Stage failed"));
}

export async function cleanupPartialStartup(
  input: PartialStartupResources,
  timing: ShutdownTiming = {},
): Promise<ShutdownExitCode> {
  const stages: ShutdownStage[] = [];
  const add = (stage: string, operation: ShutdownOperation | undefined): void => {
    if (operation) {
      stages.push([stage, operation]);
    }
  };
  for (const waiters of input.requestWaiters ?? []) {
    add("request_waiter_release", waiters.releaseWaiters.bind(waiters));
    add("request_waiter_drain", waiters.drainReleasedReads.bind(waiters));
  }
  add("fastify_close", input.app?.close.bind(input.app));
  add("bridge_drain", input.bridgeStateTracker?.dispose.bind(input.bridgeStateTracker));
  add("activation_dispose", input.activationReminderService?.dispose.bind(input.activationReminderService));
  const logFailure = createFailureLogger("[StartupCleanup] Stage failed");
  return runBoundedShutdown({
    ...timing,
    stages,
    forceFence: () => forceResources(input, logFailure),
    closeDatabase: input.dbConnector?.close.bind(input.dbConnector),
    logFailure,
  });
}

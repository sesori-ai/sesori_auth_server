import { safeErrorType } from "./lib/errors.js";
import type { MongoDbConnector } from "./db/mongo-db-connector.js";
import type { ActivationReminderService } from "./services/activation-reminder-service.js";
import type { BridgeStateTracker } from "./services/bridge-state-tracker.js";

export const SHUTDOWN_DRAIN_DEADLINE_MS = 15_000;
export const SHUTDOWN_HARD_DEADLINE_MS = 22_000;

export type ShutdownSignal = "SIGINT" | "SIGTERM";
export type ShutdownExitCode = 0 | 1;

export type ShutdownApp = {
  close: () => Promise<void>;
  closeAllConnections: () => void;
};
type TimeoutHandle = { unref?: () => unknown };

export type ShutdownTimers = {
  setTimeout: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearTimeout: (handle: TimeoutHandle) => void;
};

export type ShutdownCoordinator = {
  shutdown: (signal: ShutdownSignal) => Promise<ShutdownExitCode>;
};

export type ShutdownCoordinatorDependencies = {
  app: ShutdownApp;
  activationReminderService: Pick<ActivationReminderService, "dispose" | "forceFence">;
  bridgeStateTracker: Pick<BridgeStateTracker, "dispose" | "forceFence">;
  dbConnector: Pick<MongoDbConnector, "close">;
  selectExit: (code: ShutdownExitCode) => void;
  timers?: ShutdownTimers;
};

type StageOutcome = { fulfilled: true } | { fulfilled: false };

const defaultTimers: ShutdownTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createShutdownCoordinator(deps: ShutdownCoordinatorDependencies): ShutdownCoordinator {
  const timers = deps.timers ?? defaultTimers;
  let shutdownPromise: Promise<ShutdownExitCode> | null = null;
  let terminalFailure = false;
  let selectedExitCode: ShutdownExitCode | null = null;

  function logFailure(stage: string, error: unknown): void {
    console.error("[Shutdown] Stage failed", { stage, errorType: safeErrorType({ error }) });
  }

  function runSafely(stage: string, operation: () => void): void {
    try {
      operation();
    } catch (error) {
      logFailure(stage, error);
    }
  }

  function forceFence(): void {
    runSafely("bridge_force_fence", () => deps.bridgeStateTracker.forceFence());
    runSafely("activation_force_fence", () => deps.activationReminderService.forceFence());
    runSafely("fastify_force_close", () => deps.app.closeAllConnections());
  }

  function selectExit(code: ShutdownExitCode): ShutdownExitCode {
    if (selectedExitCode !== null) {
      return selectedExitCode;
    }

    selectedExitCode = code;
    try {
      deps.selectExit(code);
    } catch (error) {
      logFailure("exit_selection", error);
    }
    return code;
  }

  function startStage(stage: string, operation: () => Promise<void>, onFailure: () => void): Promise<StageOutcome> {
    try {
      return operation().then(
        () => ({ fulfilled: true }),
        (error: unknown) => {
          if (!terminalFailure && selectedExitCode === null) {
            logFailure(stage, error);
            onFailure();
          }
          return { fulfilled: false };
        },
      );
    } catch (error) {
      logFailure(stage, error);
      onFailure();
      return Promise.resolve({ fulfilled: false });
    }
  }

  async function run(signal: ShutdownSignal): Promise<ShutdownExitCode> {
    console.log("[Shutdown] Started", { signal });

    let resolveHardDeadline!: (code: ShutdownExitCode) => void;
    const hardDeadline = new Promise<ShutdownExitCode>((resolve) => {
      resolveHardDeadline = resolve;
    });
    const hardTimer = timers.setTimeout(() => {
      terminalFailure = true;
      forceFence();
      resolveHardDeadline(selectExit(1));
    }, SHUTDOWN_HARD_DEADLINE_MS);

    let resolveStageFailure!: () => void;
    const stageFailure = new Promise<void>((resolve) => {
      resolveStageFailure = resolve;
    });

    const bridgeDrain = startStage("bridge_drain", () => deps.bridgeStateTracker.dispose(), resolveStageFailure);
    const activationDrain = startStage(
      "activation_dispose",
      () => deps.activationReminderService.dispose(),
      resolveStageFailure,
    );
    const appClose = startStage("fastify_close", () => deps.app.close(), resolveStageFailure);
    const shutdownGroup = Promise.all([appClose, bridgeDrain, activationDrain]);

    let resolveDrainDeadline!: () => void;
    const drainDeadline = new Promise<void>((resolve) => {
      resolveDrainDeadline = resolve;
    });
    const drainTimer = timers.setTimeout(resolveDrainDeadline, SHUTDOWN_DRAIN_DEADLINE_MS);
    drainTimer.unref?.();

    const groupResult = await Promise.race([
      shutdownGroup.then((outcomes) => ({ type: "settled" as const, outcomes })),
      stageFailure.then(() => ({ type: "failed" as const })),
      drainDeadline.then(() => ({ type: "timeout" as const })),
      hardDeadline.then((code) => ({ type: "hard" as const, code })),
    ]);
    timers.clearTimeout(drainTimer);

    if (groupResult.type === "hard") {
      return groupResult.code;
    }

    const groupSucceeded = groupResult.type === "settled" && groupResult.outcomes.every((outcome) => outcome.fulfilled);
    if (!groupSucceeded) {
      terminalFailure = true;
      forceFence();
      return hardDeadline;
    }

    const dbClose = startStage(
      "mongodb_close",
      () => deps.dbConnector.close(),
      () => undefined,
    );
    const dbResult = await Promise.race([
      dbClose.then((outcome) => ({ type: "database" as const, outcome })),
      hardDeadline.then((code) => ({ type: "hard" as const, code })),
    ]);
    if (dbResult.type === "hard") {
      return dbResult.code;
    }

    timers.clearTimeout(hardTimer);
    return selectExit(dbResult.outcome.fulfilled ? 0 : 1);
  }

  return {
    shutdown(signal) {
      shutdownPromise ??= run(signal);
      return shutdownPromise;
    },
  };
}

export async function cleanupPartialStartup(input: {
  app?: Pick<ShutdownApp, "close"> | null;
  activationReminderService?: Pick<ActivationReminderService, "dispose" | "forceFence"> | null;
  bridgeStateTracker?: Pick<BridgeStateTracker, "dispose" | "forceFence"> | null;
  dbConnector?: Pick<MongoDbConnector, "close"> | null;
}): Promise<void> {
  function logFailure(stage: string, error: unknown): void {
    console.error("[StartupCleanup] Stage failed", { stage, errorType: safeErrorType({ error }) });
  }

  function force(stage: string, operation: (() => void) | undefined): void {
    try {
      operation?.();
    } catch (error) {
      logFailure(stage, error);
    }
  }

  force("bridge_force_fence", input.bridgeStateTracker?.forceFence.bind(input.bridgeStateTracker));
  force("activation_force_fence", input.activationReminderService?.forceFence.bind(input.activationReminderService));

  const stages: Array<{ stage: string; operation: (() => Promise<void>) | undefined }> = [
    { stage: "fastify_close", operation: input.app?.close.bind(input.app) },
    { stage: "bridge_drain", operation: input.bridgeStateTracker?.dispose.bind(input.bridgeStateTracker) },
    {
      stage: "activation_dispose",
      operation: input.activationReminderService?.dispose.bind(input.activationReminderService),
    },
  ];
  await Promise.all(
    stages.map(async ({ stage, operation }) => {
      try {
        await operation?.();
      } catch (error) {
        logFailure(stage, error);
      }
    }),
  );

  try {
    await input.dbConnector?.close();
  } catch (error) {
    logFailure("mongodb_close", error);
  }
}

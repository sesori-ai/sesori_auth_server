const SHUTDOWN_HARD_DEADLINE_MS = 22_000;

export type ShutdownDeadlineTimer = {
  clear(): void;
};

export type ShutdownDeadlineTimers = {
  readonly setTimeout: (callback: () => void, milliseconds: number) => ShutdownDeadlineTimer;
};

export type ShutdownWaiterOwner = {
  releaseWaiters(): void;
  drainReleasedReads(): Promise<void>;
};

export type ShutdownProducer = {
  dispose(): Promise<void> | void;
};

export type ShutdownRealtimeService = ShutdownProducer & {
  beginShutdown(): void;
};

export type ShutdownMongo = {
  close(): Promise<void>;
};

export type ShutdownApp = {
  close(): Promise<void>;
};

export type ShutdownHandler = (signal: NodeJS.Signals | string) => Promise<void>;

export function createShutdownHandler(deps: {
  readonly app: ShutdownApp;
  readonly mongo: ShutdownMongo;
  readonly waiters: readonly ShutdownWaiterOwner[];
  readonly producers: readonly ShutdownProducer[];
  readonly realtimeService: ShutdownRealtimeService | null;
  readonly exit: (code: 0 | 1) => void;
  readonly deadlineMs?: number;
  readonly deadlineTimers?: ShutdownDeadlineTimers;
  readonly log?: (message: string, fields?: object) => void;
}): ShutdownHandler {
  let shutdownPromise: Promise<void> | null = null;
  let exited = false;
  const deadlineMs = deps.deadlineMs ?? SHUTDOWN_HARD_DEADLINE_MS;
  const deadlineTimers = deps.deadlineTimers ?? {
    setTimeout: (callback: () => void, milliseconds: number): ShutdownDeadlineTimer => {
      const timeout = setTimeout(callback, milliseconds);
      return { clear: () => clearTimeout(timeout) };
    },
  };
  const log = deps.log ?? ((message, fields) => console.log(message, fields ?? ""));

  const exitOnce = (code: 0 | 1): void => {
    if (exited) {
      return;
    }

    exited = true;
    deps.exit(code);
  };

  return (signal) => {
    shutdownPromise ??= runShutdown({ ...deps, deadlineMs, deadlineTimers, log, signal }).then(
      () => exitOnce(0),
      (error: unknown) => {
        log("[Shutdown] failed", { errorType: error instanceof Error ? error.name : typeof error });
        exitOnce(1);
      },
    );
    return shutdownPromise;
  };
}

async function runShutdown(deps: {
  readonly app: ShutdownApp;
  readonly mongo: ShutdownMongo;
  readonly waiters: readonly ShutdownWaiterOwner[];
  readonly producers: readonly ShutdownProducer[];
  readonly realtimeService: ShutdownRealtimeService | null;
  readonly deadlineMs: number;
  readonly deadlineTimers: ShutdownDeadlineTimers;
  readonly signal: NodeJS.Signals | string;
  readonly log: (message: string, fields?: object) => void;
}): Promise<void> {
  deps.log("[Shutdown] start", { signal: deps.signal });
  await runWithDeadline(runOrderedShutdown(deps), deps.deadlineMs, deps.deadlineTimers);
}

async function runOrderedShutdown(deps: {
  readonly app: ShutdownApp;
  readonly mongo: ShutdownMongo;
  readonly waiters: readonly ShutdownWaiterOwner[];
  readonly producers: readonly ShutdownProducer[];
  readonly realtimeService: ShutdownRealtimeService | null;
  readonly log: (message: string, fields?: object) => void;
}): Promise<void> {
  for (const waiter of deps.waiters) {
    waiter.releaseWaiters();
  }
  deps.log("[Shutdown] waiters released");

  deps.realtimeService?.beginShutdown();
  const producerDisposals = [
    ...deps.producers.map((producer) => disposeProducer(producer)),
    deps.realtimeService ? disposeProducer(deps.realtimeService) : Promise.resolve(),
  ];

  await Promise.all([...producerDisposals, deps.app.close()]);
  for (const waiter of deps.waiters) {
    await waiter.drainReleasedReads();
  }

  await deps.mongo.close();
  deps.log("[Shutdown] MongoDB closed");
}

function disposeProducer(producer: ShutdownProducer): Promise<void> {
  try {
    return Promise.resolve(producer.dispose());
  } catch (error) {
    return Promise.reject(error);
  }
}

async function runWithDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  deadlineTimers: ShutdownDeadlineTimers,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = deadlineTimers.setTimeout(() => reject(new ShutdownDeadlineExceeded()), deadlineMs);
    promise.then(
      (value) => {
        timeout.clear();
        resolve(value);
      },
      (error: unknown) => {
        timeout.clear();
        reject(error);
      },
    );
  });
}

export class ShutdownDeadlineExceeded extends Error {
  constructor() {
    super("shutdown deadline exceeded");
    this.name = "ShutdownDeadlineExceeded";
  }
}

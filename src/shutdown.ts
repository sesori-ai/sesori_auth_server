const SHUTDOWN_HARD_DEADLINE_MS = 22_000;

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
  readonly log?: (message: string, fields?: object) => void;
}): ShutdownHandler {
  let shutdownPromise: Promise<void> | null = null;
  let exited = false;
  const deadlineMs = deps.deadlineMs ?? SHUTDOWN_HARD_DEADLINE_MS;
  const log = deps.log ?? ((message, fields) => console.log(message, fields ?? ""));

  const exitOnce = (code: 0 | 1): void => {
    if (exited) {
      return;
    }

    exited = true;
    deps.exit(code);
  };

  return (signal) => {
    shutdownPromise ??= runShutdown({ ...deps, deadlineMs, log, signal }).then(
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
  readonly signal: NodeJS.Signals | string;
  readonly log: (message: string, fields?: object) => void;
}): Promise<void> {
  deps.log("[Shutdown] start", { signal: deps.signal });
  const abort = AbortSignal.timeout(deps.deadlineMs);
  await runWithDeadline(runOrderedShutdown(deps), abort);
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
    ...deps.producers.map((producer) => Promise.resolve(producer.dispose())),
    deps.realtimeService ? deps.realtimeService.dispose() : Promise.resolve(),
  ];

  await Promise.all([...producerDisposals, deps.app.close()]);
  for (const waiter of deps.waiters) {
    await waiter.drainReleasedReads();
  }

  await deps.mongo.close();
  deps.log("[Shutdown] MongoDB closed");
}

async function runWithDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new ShutdownDeadlineExceeded();
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new ShutdownDeadlineExceeded());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
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

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
  // Started now, awaited after app.close(): these drains only need MongoDB,
  // which closes last, so they cost no extra wall clock and do not hold the
  // HTTP listener open while they finish.
  const producerDisposals = deps.producers.map((producer) => drainProducer(producer, deps.log));

  // Realtime disposal must COMPLETE before app.close(). @fastify/websocket
  // registers a preClose hook that closes every client socket, and Fastify runs
  // preClose ahead of onClose. A session's terminal frame is emitted only after
  // an awaited usage write, so racing the two drops the `service_restarting`
  // frame onto an already-closed socket and the client sees a bare close —
  // exactly what ServiceRestarting and beginShutdown() exist to prevent.
  if (deps.realtimeService) {
    await drainProducer(deps.realtimeService, deps.log);
  }

  await deps.app.close();
  await Promise.all(producerDisposals);
  for (const waiter of deps.waiters) {
    await waiter.drainReleasedReads();
  }

  await deps.mongo.close();
  deps.log("[Shutdown] MongoDB closed");
}

/**
 * Runs a producer's disposal as a best-effort drain that never rejects.
 *
 * Disposal drains bound how long we wait for in-flight background work; they
 * do not own a resource whose close order matters. Treating a drain timeout as
 * fatal skipped `mongo.close()` and exited 1, which turned an ordinary SIGTERM
 * arriving mid-sweep into a failed container termination — while the immediate
 * `process.exit(1)` killed the very in-flight work the open connection was
 * supposed to protect. A drain that does not finish is logged loudly and the
 * ordered shutdown continues; the hard deadline remains the backstop that
 * genuinely reports failure.
 */
function drainProducer(producer: ShutdownProducer, log: (message: string, fields?: object) => void): Promise<void> {
  return disposeProducer(producer).catch((error: unknown) => {
    log("[Shutdown] disposal degraded", { errorType: error instanceof Error ? error.name : typeof error });
  });
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

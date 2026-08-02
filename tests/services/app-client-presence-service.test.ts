import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { DevicePlatform } from "../../src/models/device.js";
import type { DeviceTokenRepository } from "../../src/repositories/device-token-repo.js";
import {
  AppClientPresenceInitialReadTimeout,
  AppClientPresenceService,
} from "../../src/services/app-client-presence-service.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

class FakeDeviceTokenRepository {
  readonly reads: Array<boolean | Promise<boolean>> = [];
  upsert: () => Promise<void> = async () => {};
  readCount = 0;

  async hasAnyForUser(): Promise<boolean> {
    const result = this.reads[this.readCount++];
    if (result === undefined) {
      throw new Error("Unexpected presence read");
    }
    return result;
  }

  async upsertToken(): Promise<void> {
    await this.upsert();
  }
}

describe("AppClientPresenceService", () => {
  it("returns immediate current presence without storing a waiter", async () => {
    const repo = new FakeDeviceTokenRepository();
    repo.reads.push(false, true);
    const service = createService(repo);

    assert.equal(await service.hasRegisteredClient({ userId: "user-a" }), false);
    assert.equal(await service.hasRegisteredClient({ userId: "user-a" }), true);
    assert.equal(repo.readCount, 2);
  });

  it("returns false at the absolute timeout and removes its abort listener", async () => {
    const repo = new FakeDeviceTokenRepository();
    repo.reads.push(false, false);
    const service = createService(repo);
    const controller = new AbortController();

    const result = await keepProcessAlive(
      service.waitForRegistration({ userId: "user-timeout", timeoutMs: 20, abortSignal: controller.signal }),
    );

    assert.equal(result, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("counts the initial read against the same absolute timeout", async () => {
    const repo = new FakeDeviceTokenRepository();
    repo.reads.push(delayResult(false, 20), false);
    const service = createService(repo);
    const startedAt = Date.now();

    const result = await keepProcessAlive(
      service.waitForRegistration({ userId: "user-budget", timeoutMs: 35, abortSignal: new AbortController().signal }),
    );

    const elapsedMs = Date.now() - startedAt;
    assert.equal(result, false);
    assert.ok(elapsedMs >= 30, `elapsed ${elapsedMs}ms`);
    assert.ok(elapsedMs < 70, `elapsed ${elapsedMs}ms`);
  });

  it("throws a typed failure when the initial read misses the deadline", async () => {
    const repo = new FakeDeviceTokenRepository();
    const lateRead = deferred<boolean>();
    repo.reads.push(lateRead.promise);
    const service = createService(repo);
    const controller = new AbortController();

    await assert.rejects(
      keepProcessAlive(
        service.waitForRegistration({ userId: "user-slow", timeoutMs: 15, abortSignal: controller.signal }),
      ),
      AppClientPresenceInitialReadTimeout,
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);

    lateRead.resolve(true);
    await delay(0);
  });

  it("returns cancellation without reading when the signal is already aborted", async () => {
    const repo = new FakeDeviceTokenRepository();
    const service = createService(repo);
    const controller = new AbortController();
    controller.abort();

    assert.equal(
      await service.waitForRegistration({ userId: "user-aborted", timeoutMs: 50, abortSignal: controller.signal }),
      null,
    );
    assert.equal(repo.readCount, 0);
  });

  it("bypasses waiter machinery and reads immediately when timeoutMs is not positive", async () => {
    const repo = new FakeDeviceTokenRepository();
    repo.reads.push(true);
    const service = createService(repo);

    const result = await service.waitForRegistration({
      userId: "user-zero",
      timeoutMs: 0,
      abortSignal: new AbortController().signal,
    });

    assert.equal(result, true);
    assert.equal(repo.readCount, 1);
  });

  it("aborts an active waiter and removes its listener", async () => {
    const repo = new FakeDeviceTokenRepository();
    repo.reads.push(false, false);
    const service = createService(repo);
    const controller = new AbortController();
    const result = service.waitForRegistration({
      userId: "user-abort",
      timeoutMs: 1_000,
      abortSignal: controller.signal,
    });
    await waitFor(() => repo.readCount === 2);

    controller.abort();

    assert.equal(await result, null);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("wakes every waiter for the registered user and leaves other users waiting", async () => {
    const repo = new FakeDeviceTokenRepository();
    repo.reads.push(false, false, false, false, false, false);
    const service = createService(repo);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const otherController = new AbortController();
    const first = service.waitForRegistration({
      userId: "user-a",
      timeoutMs: 1_000,
      abortSignal: firstController.signal,
    });
    const second = service.waitForRegistration({
      userId: "user-a",
      timeoutMs: 1_000,
      abortSignal: secondController.signal,
    });
    const other = service.waitForRegistration({
      userId: "user-b",
      timeoutMs: 1_000,
      abortSignal: otherController.signal,
    });
    await waitFor(() => repo.readCount === 6);

    await service.registerToken({ userId: "user-a", token: "token-a", platform: DevicePlatform.ios });

    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    const otherState = await Promise.race([other.then(() => "settled"), delayResult("waiting", 10)]);
    assert.equal(otherState, "waiting");
    otherController.abort();
    assert.equal(await other, null);
  });

  it("does not wake a waiter until the token upsert succeeds", async () => {
    const repo = new FakeDeviceTokenRepository();
    repo.reads.push(false, false);
    const upsert = deferred<void>();
    repo.upsert = () => upsert.promise;
    const service = createService(repo);
    const controller = new AbortController();
    const waiting = service.waitForRegistration({
      userId: "user-durable",
      timeoutMs: 1_000,
      abortSignal: controller.signal,
    });
    await waitFor(() => repo.readCount === 2);
    const registration = service.registerToken({
      userId: "user-durable",
      token: "token-durable",
      platform: DevicePlatform.android,
    });

    assert.equal(await Promise.race([waiting.then(() => "settled"), delayResult("waiting", 10)]), "waiting");
    upsert.resolve();
    await registration;
    assert.equal(await waiting, true);
  });

  it("does not wake a waiter when the token upsert fails", async () => {
    const repo = new FakeDeviceTokenRepository();
    repo.reads.push(false, false);
    repo.upsert = async () => {
      throw new Error("write failed");
    };
    const service = createService(repo);
    const controller = new AbortController();
    const waiting = service.waitForRegistration({
      userId: "user-failed",
      timeoutMs: 1_000,
      abortSignal: controller.signal,
    });
    await waitFor(() => repo.readCount === 2);

    await assert.rejects(
      service.registerToken({ userId: "user-failed", token: "token-failed", platform: DevicePlatform.linux }),
      /write failed/,
    );
    assert.equal(await Promise.race([waiting.then(() => "settled"), delayResult("waiting", 10)]), "waiting");
    controller.abort();
    assert.equal(await waiting, null);
  });

  it("closes the query-to-wait race with a post-registration recheck", async () => {
    const repo = new FakeDeviceTokenRepository();
    repo.reads.push(false, true);
    const service = createService(repo);

    assert.equal(
      await service.waitForRegistration({
        userId: "user-race",
        timeoutMs: 1_000,
        abortSignal: new AbortController().signal,
      }),
      true,
    );
  });

  it("cleans the waiter and listener when the post-registration recheck fails", async () => {
    const repo = new FakeDeviceTokenRepository();
    repo.reads.push(false, Promise.reject(new Error("recheck failed")));
    const service = createService(repo);
    const controller = new AbortController();

    await assert.rejects(
      service.waitForRegistration({ userId: "user-error", timeoutMs: 1_000, abortSignal: controller.signal }),
      /recheck failed/,
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
});

function createService(repo: FakeDeviceTokenRepository): AppClientPresenceService {
  return new AppClientPresenceService({ deviceTokenRepo: repo as unknown as DeviceTokenRepository });
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function delayResult<T>(value: T, ms: number): Promise<T> {
  await delay(ms);
  return value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not reached before deadline");
    }
    await delay(1);
  }
}

async function keepProcessAlive<T>(promise: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

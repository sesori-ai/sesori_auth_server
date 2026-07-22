import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ObjectId } from "mongodb";
import { BadRequestError } from "../../src/lib/errors.js";
import type { SettingsConfiguration } from "../../src/models/documents.js";
import type { SettingsConfigurationRepository } from "../../src/repositories/settings-configuration-repo.js";
import { SettingsService } from "../../src/services/settings-service.js";

const USER_ID = new ObjectId().toHexString();
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

function makeDoc(deviceId: string, createdAtMs: number): SettingsConfiguration {
  const createdAt = new Date(createdAtMs);
  return {
    _id: new ObjectId(),
    userId: new ObjectId(USER_ID),
    deviceId,
    notifications: {},
    createdAt,
    updatedAt: createdAt,
  };
}

function others(count: number): SettingsConfiguration[] {
  return Array.from({ length: count }, (_, i) => makeDoc(`other-${i}`, 1000));
}

type FakeRepo = {
  repo: SettingsConfigurationRepository;
  calls: { findByUserId: number; upsert: number; delete: { userId: string; deviceId: string }[] };
};

function createFakeRepo(config: {
  existing: SettingsConfiguration | null;
  findByUserIdResults: SettingsConfiguration[][];
  upsertResult: SettingsConfiguration;
}): FakeRepo {
  const calls = { findByUserId: 0, upsert: 0, delete: [] as { userId: string; deviceId: string }[] };
  const repo = {
    findByUserAndDevice: async () => config.existing,
    findByUserId: async () => {
      const result = config.findByUserIdResults[calls.findByUserId] ?? [];
      calls.findByUserId += 1;
      return result;
    },
    upsert: async () => {
      calls.upsert += 1;
      return config.upsertResult;
    },
    deleteByUserAndDevice: async (userId: string, deviceId: string) => {
      calls.delete.push({ userId, deviceId });
    },
  };
  return { repo: repo as unknown as SettingsConfigurationRepository, calls };
}

describe("SettingsService.getForDevice", () => {
  it("returns all-enabled defaults for an unknown device", async () => {
    const { repo } = createFakeRepo({ existing: null, findByUserIdResults: [], upsertResult: makeDoc(DEVICE_ID, 0) });
    const service = new SettingsService({ settingsRepo: repo });

    const view = await service.getForDevice(USER_ID, DEVICE_ID);

    assert.deepEqual(view.notifications, {
      aiInteraction: true,
      sessionMessage: true,
      connectionStatus: true,
      systemUpdate: true,
    });
    assert.equal(view.updatedAt, null);
  });
});

describe("SettingsService.updateForDevice cap enforcement", () => {
  it("rejects a new device at the pre-check when the user is already at the cap", async () => {
    const { repo, calls } = createFakeRepo({
      existing: null,
      findByUserIdResults: [others(50)],
      upsertResult: makeDoc(DEVICE_ID, 2000),
    });
    const service = new SettingsService({ settingsRepo: repo });

    await assert.rejects(
      () => service.updateForDevice(USER_ID, DEVICE_ID, { notifications: { aiInteraction: false } }),
      (error) => error instanceof BadRequestError,
    );
    assert.equal(calls.upsert, 0);
  });

  it("rolls the insert back when a concurrent burst pushes this device past the cap", async () => {
    const ourDoc = makeDoc(DEVICE_ID, 2000);
    const { repo, calls } = createFakeRepo({
      existing: null,
      findByUserIdResults: [others(49), [...others(50), ourDoc]],
      upsertResult: ourDoc,
    });
    const service = new SettingsService({ settingsRepo: repo });

    await assert.rejects(
      () => service.updateForDevice(USER_ID, DEVICE_ID, { notifications: { aiInteraction: false } }),
      (error) => error instanceof BadRequestError,
    );
    assert.equal(calls.upsert, 1);
    assert.deepEqual(calls.delete, [{ userId: USER_ID, deviceId: DEVICE_ID }]);
  });

  it("keeps a new device that lands within the cap after insert", async () => {
    const ourDoc: SettingsConfiguration = { ...makeDoc(DEVICE_ID, 2000), notifications: { aiInteraction: false } };
    const { repo, calls } = createFakeRepo({
      existing: null,
      findByUserIdResults: [others(49), [...others(49), ourDoc]],
      upsertResult: ourDoc,
    });
    const service = new SettingsService({ settingsRepo: repo });

    const view = await service.updateForDevice(USER_ID, DEVICE_ID, { notifications: { aiInteraction: false } });

    assert.equal(calls.delete.length, 0);
    assert.equal(view.deviceId, DEVICE_ID);
    assert.equal(view.notifications.aiInteraction, false);
  });

  it("updates an existing device without running any cap checks", async () => {
    const existing = makeDoc(DEVICE_ID, 1000);
    const updated: SettingsConfiguration = {
      ...existing,
      notifications: { sessionMessage: false },
      updatedAt: new Date(3000),
    };
    const { repo, calls } = createFakeRepo({
      existing,
      findByUserIdResults: [],
      upsertResult: updated,
    });
    const service = new SettingsService({ settingsRepo: repo });

    const view = await service.updateForDevice(USER_ID, DEVICE_ID, { notifications: { sessionMessage: false } });

    assert.equal(calls.findByUserId, 0);
    assert.equal(calls.delete.length, 0);
    assert.equal(view.notifications.sessionMessage, false);
    assert.equal(view.notifications.aiInteraction, true);
  });
});

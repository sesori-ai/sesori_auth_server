import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ObjectId } from "mongodb";
import type { SettingsConfiguration } from "../../src/models/documents.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

type NotificationsBody = {
  aiInteraction: boolean;
  sessionMessage: boolean;
  connectionStatus: boolean;
  systemUpdate: boolean;
};

type SettingsBody = {
  deviceId: string;
  notifications: NotificationsBody;
  updatedAt: string | null;
};

const ALL_ENABLED: NotificationsBody = {
  aiInteraction: true,
  sessionMessage: true,
  connectionStatus: true,
  systemUpdate: true,
};

// Seed documents whose notifications may carry keys outside the current registry
// (a toggle that was later removed), so evolution behaviour can be exercised.
type SeedableSettings = Omit<SettingsConfiguration, "notifications"> & { notifications: Record<string, boolean> };

describe("/auth/settings routes", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  function getSettings(accessToken: string | null, deviceId: string) {
    return ctx.app.inject({
      method: "GET",
      url: `/auth/settings/${encodeURIComponent(deviceId)}`,
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
  }

  function patchSettings(accessToken: string | null, deviceId: string, body: unknown) {
    return ctx.app.inject({
      method: "PATCH",
      url: `/auth/settings/${encodeURIComponent(deviceId)}`,
      headers: {
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
  }

  function deleteSettings(accessToken: string | null, deviceId: string) {
    return ctx.app.inject({
      method: "DELETE",
      url: `/auth/settings/${encodeURIComponent(deviceId)}`,
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
  }

  it("GET returns all-enabled defaults for a device with no stored settings", async () => {
    const user = await ctx.createUser();
    const deviceId = randomUUID();

    const res = await getSettings(user.accessToken, deviceId);

    assert.equal(res.statusCode, 200);
    const body = res.json<SettingsBody>();
    assert.equal(body.deviceId, deviceId);
    assert.deepEqual(body.notifications, ALL_ENABLED);
    assert.equal(body.updatedAt, null);
  });

  it("PATCH changes a single toggle and returns the fully-resolved settings", async () => {
    const user = await ctx.createUser();
    const deviceId = randomUUID();

    const res = await patchSettings(user.accessToken, deviceId, { notifications: { aiInteraction: false } });

    assert.equal(res.statusCode, 200);
    const body = res.json<SettingsBody>();
    assert.deepEqual(body.notifications, { ...ALL_ENABLED, aiInteraction: false });
    assert.equal(typeof body.updatedAt, "string");
  });

  it("PATCH persists and merges without clobbering other toggles", async () => {
    const user = await ctx.createUser();
    const deviceId = randomUUID();

    await patchSettings(user.accessToken, deviceId, { notifications: { aiInteraction: false } });
    await patchSettings(user.accessToken, deviceId, { notifications: { sessionMessage: false } });

    const res = await getSettings(user.accessToken, deviceId);
    const body = res.json<SettingsBody>();
    assert.deepEqual(body.notifications, {
      aiInteraction: false,
      sessionMessage: false,
      connectionStatus: true,
      systemUpdate: true,
    });
  });

  it("rejects payloads that change nothing or carry unknown fields", async () => {
    const user = await ctx.createUser();
    const deviceId = randomUUID();

    const empty = await patchSettings(user.accessToken, deviceId, {});
    const emptyGroup = await patchSettings(user.accessToken, deviceId, { notifications: {} });
    const unknownGroup = await patchSettings(user.accessToken, deviceId, { foo: true });
    const unknownToggle = await patchSettings(user.accessToken, deviceId, { notifications: { bogus: true } });
    const nonBoolean = await patchSettings(user.accessToken, deviceId, { notifications: { aiInteraction: "yes" } });

    assert.equal(empty.statusCode, 400);
    assert.equal(emptyGroup.statusCode, 400);
    assert.equal(unknownGroup.statusCode, 400);
    assert.equal(unknownToggle.statusCode, 400);
    assert.equal(nonBoolean.statusCode, 400);
  });

  it("requires a Bearer token on every route", async () => {
    const deviceId = randomUUID();

    const get = await getSettings(null, deviceId);
    const patch = await patchSettings(null, deviceId, { notifications: { aiInteraction: false } });
    const removed = await deleteSettings(null, deviceId);

    assert.equal(get.statusCode, 401);
    assert.equal(patch.statusCode, 401);
    assert.equal(removed.statusCode, 401);
  });

  it("rejects a deviceId that is not a UUIDv4", async () => {
    const user = await ctx.createUser();

    const get = await getSettings(user.accessToken, "not-a-uuid");
    const patch = await patchSettings(user.accessToken, "not-a-uuid", { notifications: { aiInteraction: false } });
    const removed = await deleteSettings(user.accessToken, "not-a-uuid");

    assert.equal(get.statusCode, 400);
    assert.equal(patch.statusCode, 400);
    assert.equal(removed.statusCode, 400);
  });

  it("treats the deviceId case-insensitively", async () => {
    const user = await ctx.createUser();
    const deviceId = randomUUID();

    const upper = await patchSettings(user.accessToken, deviceId.toUpperCase(), {
      notifications: { connectionStatus: false },
    });
    assert.equal(upper.statusCode, 200);
    assert.equal(upper.json<SettingsBody>().deviceId, deviceId);

    const res = await getSettings(user.accessToken, deviceId);
    assert.equal(res.json<SettingsBody>().notifications.connectionStatus, false);

    const removed = await deleteSettings(user.accessToken, deviceId.toUpperCase());
    assert.equal(removed.statusCode, 200);

    const afterDelete = await getSettings(user.accessToken, deviceId);
    assert.equal(afterDelete.json<SettingsBody>().notifications.connectionStatus, true);
  });

  it("scopes settings to the caller — a device is isolated per user (no IDOR)", async () => {
    const userA = await ctx.createUser();
    const userB = await ctx.createUser();
    const deviceId = randomUUID();

    await patchSettings(userA.accessToken, deviceId, { notifications: { aiInteraction: false } });

    const bReadsSharedDeviceId = await getSettings(userB.accessToken, deviceId);
    assert.deepEqual(bReadsSharedDeviceId.json<SettingsBody>().notifications, ALL_ENABLED);

    await patchSettings(userB.accessToken, deviceId, { notifications: { systemUpdate: false } });

    const aStillOwnsItsDoc = await getSettings(userA.accessToken, deviceId);
    assert.deepEqual(aStillOwnsItsDoc.json<SettingsBody>().notifications, { ...ALL_ENABLED, aiInteraction: false });

    const bOwnsSeparateDoc = await getSettings(userB.accessToken, deviceId);
    assert.deepEqual(bOwnsSeparateDoc.json<SettingsBody>().notifications, { ...ALL_ENABLED, systemUpdate: false });
  });

  it("resolves defaults for toggles missing from a legacy record and ignores retired ones", async () => {
    const user = await ctx.createUser();
    const deviceId = randomUUID();
    const now = new Date();
    await ctx.dbAccessor
      .getCollection<SeedableSettings>(MongoDbDatabase.Auth, AuthDbCollection.SettingsConfiguration)
      .insertOne({
        _id: new ObjectId(),
        userId: new ObjectId(user.userId),
        deviceId,
        notifications: { sessionMessage: false, retiredToggle: true },
        createdAt: now,
        updatedAt: now,
      });

    const res = await getSettings(user.accessToken, deviceId);
    const body = res.json<SettingsBody>();
    assert.deepEqual(body.notifications, { ...ALL_ENABLED, sessionMessage: false });
    assert.ok(!("retiredToggle" in body.notifications));
  });

  it("DELETE clears the device's stored overrides and returns it to the defaults", async () => {
    const user = await ctx.createUser();
    const deviceId = randomUUID();

    await patchSettings(user.accessToken, deviceId, {
      notifications: { aiInteraction: false, systemUpdate: false },
    });

    const removed = await deleteSettings(user.accessToken, deviceId);
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json(), { ok: true });

    // A null updatedAt is only reachable when no document exists, so this
    // distinguishes a deleted record from one reset to all-true values.
    const res = await getSettings(user.accessToken, deviceId);
    const body = res.json<SettingsBody>();
    assert.deepEqual(body.notifications, ALL_ENABLED);
    assert.equal(body.updatedAt, null);
  });

  it("DELETE is idempotent for a device that stored nothing", async () => {
    const user = await ctx.createUser();
    const deviceId = randomUUID();

    const first = await deleteSettings(user.accessToken, deviceId);
    const second = await deleteSettings(user.accessToken, deviceId);

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);

    const res = await getSettings(user.accessToken, deviceId);
    assert.deepEqual(res.json<SettingsBody>().notifications, ALL_ENABLED);
  });

  it("scopes DELETE to the caller — clearing a shared deviceId leaves the other user's settings intact", async () => {
    const userA = await ctx.createUser();
    const userB = await ctx.createUser();
    const deviceId = randomUUID();

    await patchSettings(userA.accessToken, deviceId, { notifications: { aiInteraction: false } });
    await patchSettings(userB.accessToken, deviceId, { notifications: { systemUpdate: false } });

    const removed = await deleteSettings(userB.accessToken, deviceId);
    assert.equal(removed.statusCode, 200);

    const aStillOwnsItsDoc = await getSettings(userA.accessToken, deviceId);
    assert.deepEqual(aStillOwnsItsDoc.json<SettingsBody>().notifications, { ...ALL_ENABLED, aiInteraction: false });

    const bWasCleared = await getSettings(userB.accessToken, deviceId);
    assert.deepEqual(bWasCleared.json<SettingsBody>().notifications, ALL_ENABLED);
  });
});

import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NOTIFICATION_SETTINGS_DEFAULTS,
  deviceIdSchema,
  notificationSettingsPatchSchema,
  resolveNotificationSettings,
  updateSettingsBodySchema,
} from "../../src/models/settings.js";

describe("resolveNotificationSettings", () => {
  it("returns all defaults (enabled) when nothing is stored", () => {
    assert.deepEqual(resolveNotificationSettings(undefined), NOTIFICATION_SETTINGS_DEFAULTS);
    assert.deepEqual(resolveNotificationSettings(null), NOTIFICATION_SETTINGS_DEFAULTS);
  });

  it("overlays only the stored toggles over the defaults", () => {
    assert.deepEqual(resolveNotificationSettings({ aiInteraction: false }), {
      aiInteraction: false,
      sessionMessage: true,
      connectionStatus: true,
      systemUpdate: true,
    });
  });

  it("honours a fully-stored set of toggles", () => {
    const allOff = { aiInteraction: false, sessionMessage: false, connectionStatus: false, systemUpdate: false };
    assert.deepEqual(resolveNotificationSettings(allOff), allOff);
  });

  it("does not mutate the shared defaults map", () => {
    resolveNotificationSettings({ aiInteraction: false });
    assert.equal(NOTIFICATION_SETTINGS_DEFAULTS.aiInteraction, true);
  });
});

describe("deviceIdSchema", () => {
  it("accepts a canonical UUIDv4", () => {
    const id = randomUUID();
    const result = deviceIdSchema.safeParse(id);
    assert.equal(result.success, true);
    assert.equal(result.data, id);
  });

  it("normalizes case and surrounding whitespace", () => {
    const id = randomUUID();
    const result = deviceIdSchema.safeParse(`  ${id.toUpperCase()}  `);
    assert.equal(result.success, true);
    assert.equal(result.data, id);
  });

  it("rejects non-UUIDv4 values", () => {
    for (const bad of ["", "not-a-uuid", "12345678-1234-1234-8234-123456789abc", randomUUID().slice(0, -1)]) {
      assert.equal(deviceIdSchema.safeParse(bad).success, false, `expected ${bad} to be rejected`);
    }
  });
});

describe("notificationSettingsPatchSchema", () => {
  it("accepts a single known toggle and an empty object", () => {
    assert.equal(notificationSettingsPatchSchema.safeParse({ aiInteraction: false }).success, true);
    assert.equal(notificationSettingsPatchSchema.safeParse({}).success, true);
  });

  it("rejects unknown keys and non-boolean values", () => {
    assert.equal(notificationSettingsPatchSchema.safeParse({ bogus: true }).success, false);
    assert.equal(notificationSettingsPatchSchema.safeParse({ aiInteraction: "yes" }).success, false);
  });
});

describe("updateSettingsBodySchema", () => {
  it("accepts a partial notifications patch", () => {
    assert.equal(updateSettingsBodySchema.safeParse({ notifications: { systemUpdate: false } }).success, true);
  });

  it("rejects a body that changes nothing", () => {
    assert.equal(updateSettingsBodySchema.safeParse({}).success, false);
    assert.equal(updateSettingsBodySchema.safeParse({ notifications: {} }).success, false);
  });

  it("rejects unknown groups and unknown toggles", () => {
    assert.equal(updateSettingsBodySchema.safeParse({ foo: true }).success, false);
    assert.equal(updateSettingsBodySchema.safeParse({ notifications: { bogus: true } }).success, false);
  });
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Messaging } from "firebase-admin/messaging";
import { DevicePlatform } from "../../src/models/device.js";
import { NotificationCategory } from "../../src/models/notification.js";
import { DeviceTokenRepository } from "../../src/repositories/device-token-repo.js";
import { SettingsConfigurationRepository } from "../../src/repositories/settings-configuration-repo.js";
import { NotificationService } from "../../src/services/notification-service.js";
import { SettingsService } from "../../src/services/settings-service.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

const DEVICE_ID = "550e8400-e29b-41d4-a716-446655440000";

function createMockMessaging() {
  const calls: unknown[][] = [];

  const messaging = {
    sendEach: async (messages: unknown[]) => {
      calls.push(messages);
      return {
        successCount: messages.length,
        failureCount: 0,
        responses: messages.map(() => ({ success: true })),
      };
    },
  } as unknown as Messaging;

  return { messaging, calls };
}

describe("notification filtering end to end", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("stops delivering a category the device switched off, then resumes when it is switched back on", async () => {
    const user = await ctx.createUser();
    const auth = { authorization: `Bearer ${user.accessToken}` };

    const registration = await ctx.app.inject({
      method: "POST",
      url: "/notifications/register-token",
      headers: auth,
      payload: { token: "fcm-token-e2e", platform: DevicePlatform.ios, deviceId: DEVICE_ID },
    });
    assert.equal(registration.statusCode, 200);

    const messaging = createMockMessaging();
    const notificationService = new NotificationService(
      new DeviceTokenRepository(ctx.dbAccessor),
      messaging.messaging,
      new SettingsService({ settingsRepo: new SettingsConfigurationRepository(ctx.dbAccessor) }),
    );

    const beforeOptOut = await notificationService.sendToUser(user.userId, {
      category: NotificationCategory.AiInteraction,
      title: "Action required",
      body: "Approve this command",
      collapseKey: null,
    });
    assert.equal(beforeOptOut.devicesNotified, 1, "a device with no stored settings defaults to enabled");

    const optOut = await ctx.app.inject({
      method: "PATCH",
      url: `/auth/settings/${DEVICE_ID}`,
      headers: auth,
      payload: { notifications: { aiInteraction: false } },
    });
    assert.equal(optOut.statusCode, 200);
    assert.equal(optOut.json().notifications.aiInteraction, false);

    const afterOptOut = await notificationService.sendToUser(user.userId, {
      category: NotificationCategory.AiInteraction,
      title: "Action required",
      body: "Approve this command",
      collapseKey: null,
    });
    assert.equal(afterOptOut.devicesNotified, 0);
    assert.equal(messaging.calls.length, 1, "FCM must not be called again once the only device opted out");

    const stillDelivered = await notificationService.sendToUser(user.userId, {
      category: NotificationCategory.SessionMessage,
      title: "New message",
      body: "Your session replied",
      collapseKey: null,
    });
    assert.equal(stillDelivered.devicesNotified, 1, "other categories stay unaffected");

    const optIn = await ctx.app.inject({
      method: "PATCH",
      url: `/auth/settings/${DEVICE_ID}`,
      headers: auth,
      payload: { notifications: { aiInteraction: true } },
    });
    assert.equal(optIn.statusCode, 200);

    const afterOptIn = await notificationService.sendToUser(user.userId, {
      category: NotificationCategory.AiInteraction,
      title: "Action required",
      body: "Approve this command",
      collapseKey: null,
    });
    assert.equal(afterOptIn.devicesNotified, 1);
  });

  it("keeps delivering to a token registered without a deviceId", async () => {
    const user = await ctx.createUser();
    const auth = { authorization: `Bearer ${user.accessToken}` };

    const registration = await ctx.app.inject({
      method: "POST",
      url: "/notifications/register-token",
      headers: auth,
      payload: { token: "fcm-token-legacy", platform: DevicePlatform.android },
    });
    assert.equal(registration.statusCode, 200);

    const optOut = await ctx.app.inject({
      method: "PATCH",
      url: `/auth/settings/${DEVICE_ID}`,
      headers: auth,
      payload: { notifications: { aiInteraction: false } },
    });
    assert.equal(optOut.statusCode, 200);

    const messaging = createMockMessaging();
    const notificationService = new NotificationService(
      new DeviceTokenRepository(ctx.dbAccessor),
      messaging.messaging,
      new SettingsService({ settingsRepo: new SettingsConfigurationRepository(ctx.dbAccessor) }),
    );

    const result = await notificationService.sendToUser(user.userId, {
      category: NotificationCategory.AiInteraction,
      title: "Action required",
      body: "Approve this command",
      collapseKey: null,
    });

    assert.equal(result.devicesNotified, 1, "an unmatched token must fail open rather than go silent");
  });

  it("rejects a server-originated category on the client send route", async () => {
    const user = await ctx.createUser();

    const response = await ctx.app.inject({
      method: "POST",
      url: "/notifications/send",
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {
        category: NotificationCategory.ConnectionStatus,
        title: "Bridge Online",
        body: "spoofed",
        collapseKey: null,
      },
    });

    assert.equal(response.statusCode, 400);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Messaging } from "firebase-admin/messaging";
import { NotificationCategory } from "../../src/models/notification.js";
import { NOTIFICATION_SETTINGS_DEFAULTS, type NotificationSettings } from "../../src/models/settings.js";
import type { DeviceTokenRepository } from "../../src/repositories/device-token-repo.js";
import {
  NotificationService,
  type NotificationPayload,
  type NotificationSettingsResolver,
} from "../../src/services/notification-service.js";

type MockResponse = { success: boolean; error?: { code: string } };
type MockToken = { userId: string; token: string; platform: string; deviceId?: string | null };

const DEVICE_A = "550e8400-e29b-41d4-a716-446655440000";
const DEVICE_B = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

function createMockMessaging(responses: MockResponse[]) {
  const calls: unknown[][] = [];

  const messaging = {
    sendEach: async (messages: unknown[]) => {
      calls.push(messages);
      return {
        successCount: responses.filter((r) => r.success).length,
        failureCount: responses.filter((r) => !r.success).length,
        responses: responses.map((r) => ({
          success: r.success,
          error: r.error ? { code: r.error.code } : undefined,
        })),
      };
    },
  } as unknown as Messaging;

  return { messaging, calls };
}

function createMockDeviceTokenRepo(tokens: MockToken[]) {
  let stored = [...tokens];

  const repo = {
    findByUserId: async (userId: string) => stored.filter((t) => t.userId === userId),
    deleteByTokens: async (tokensToDelete: string[]) => {
      stored = stored.filter((t) => !tokensToDelete.includes(t.token));
    },
  } as unknown as DeviceTokenRepository;

  return { repo, getStoredTokens: () => [...stored] };
}

function createMockSettingsResolver(
  byDevice: Record<string, Partial<NotificationSettings>>,
): NotificationSettingsResolver {
  return {
    resolveNotificationsByDevice: async () =>
      new Map(
        Object.entries(byDevice).map(([deviceId, overrides]) => [
          deviceId,
          { ...NOTIFICATION_SETTINGS_DEFAULTS, ...overrides },
        ]),
      ),
  };
}

function buildPayload(category: NotificationCategory): NotificationPayload {
  return { category, title: "Title", body: "Body", collapseKey: null };
}

function sentTokens(calls: unknown[][]): string[] {
  return (calls[0] ?? []).map((message) => (message as { token: string }).token);
}

describe("NotificationService category filtering", () => {
  it("drops a device that disabled the category", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "token-a", platform: "ios", deviceId: DEVICE_A },
    ]);
    const messaging = createMockMessaging([]);
    const settings = createMockSettingsResolver({ [DEVICE_A]: { aiInteraction: false } });
    const service = new NotificationService(tokenRepo.repo, messaging.messaging, settings);

    const result = await service.sendToUser("user-1", buildPayload(NotificationCategory.AiInteraction));

    assert.deepEqual(result, { devicesNotified: 0, retryableFailures: 0 });
    assert.equal(messaging.calls.length, 0, "FCM must not be called when every device opted out");
  });

  it("delivers to a device that left the category enabled", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "token-a", platform: "ios", deviceId: DEVICE_A },
    ]);
    const messaging = createMockMessaging([{ success: true }]);
    const settings = createMockSettingsResolver({ [DEVICE_A]: { sessionMessage: false } });
    const service = new NotificationService(tokenRepo.repo, messaging.messaging, settings);

    const result = await service.sendToUser("user-1", buildPayload(NotificationCategory.AiInteraction));

    assert.equal(result.devicesNotified, 1);
    assert.deepEqual(sentTokens(messaging.calls), ["token-a"]);
  });

  it("filters per device rather than per user", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "token-a", platform: "ios", deviceId: DEVICE_A },
      { userId: "user-1", token: "token-b", platform: "android", deviceId: DEVICE_B },
    ]);
    const messaging = createMockMessaging([{ success: true }]);
    const settings = createMockSettingsResolver({
      [DEVICE_A]: { aiInteraction: false },
      [DEVICE_B]: { aiInteraction: true },
    });
    const service = new NotificationService(tokenRepo.repo, messaging.messaging, settings);

    await service.sendToUser("user-1", buildPayload(NotificationCategory.AiInteraction));

    assert.deepEqual(sentTokens(messaging.calls), ["token-b"]);
  });

  it("delivers to a token that has no deviceId yet", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "legacy-token", platform: "ios", deviceId: null },
      { userId: "user-1", token: "token-a", platform: "android", deviceId: DEVICE_A },
    ]);
    const messaging = createMockMessaging([{ success: true }]);
    const settings = createMockSettingsResolver({ [DEVICE_A]: { aiInteraction: false } });
    const service = new NotificationService(tokenRepo.repo, messaging.messaging, settings);

    await service.sendToUser("user-1", buildPayload(NotificationCategory.AiInteraction));

    assert.deepEqual(sentTokens(messaging.calls), ["legacy-token"]);
  });

  it("delivers to a device that has stored no settings at all", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "token-a", platform: "ios", deviceId: DEVICE_A },
    ]);
    const messaging = createMockMessaging([{ success: true }]);
    const settings = createMockSettingsResolver({});
    const service = new NotificationService(tokenRepo.repo, messaging.messaging, settings);

    const result = await service.sendToUser("user-1", buildPayload(NotificationCategory.AiInteraction));

    assert.equal(result.devicesNotified, 1);
  });

  it("honours the connection status toggle used by bridge state changes", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "token-a", platform: "ios", deviceId: DEVICE_A },
    ]);
    const messaging = createMockMessaging([]);
    const settings = createMockSettingsResolver({ [DEVICE_A]: { connectionStatus: false } });
    const service = new NotificationService(tokenRepo.repo, messaging.messaging, settings);

    const result = await service.sendToUser("user-1", buildPayload(NotificationCategory.ConnectionStatus));

    assert.equal(result.devicesNotified, 0);
    assert.equal(messaging.calls.length, 0);
  });

  it("honours the system update toggle used by activation reminders", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "token-a", platform: "ios", deviceId: DEVICE_A },
    ]);
    const messaging = createMockMessaging([]);
    const settings = createMockSettingsResolver({ [DEVICE_A]: { systemUpdate: false } });
    const service = new NotificationService(tokenRepo.repo, messaging.messaging, settings);

    const result = await service.sendToUser("user-1", buildPayload(NotificationCategory.SystemUpdate));

    assert.equal(result.devicesNotified, 0);
    assert.equal(messaging.calls.length, 0);
  });

  // Stale-token cleanup indexes FCM responses positionally, so it has to line up
  // with the filtered list; against the unfiltered list it would delete the wrong
  // device's token.
  it("maps stale-token cleanup back to the filtered tokens", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "token-a", platform: "ios", deviceId: DEVICE_A },
      { userId: "user-1", token: "token-b", platform: "android", deviceId: DEVICE_B },
    ]);
    const messaging = createMockMessaging([
      { success: false, error: { code: "messaging/registration-token-not-registered" } },
    ]);
    const settings = createMockSettingsResolver({
      [DEVICE_A]: { aiInteraction: true },
      [DEVICE_B]: { aiInteraction: false },
    });
    const service = new NotificationService(tokenRepo.repo, messaging.messaging, settings);

    await service.sendToUser("user-1", buildPayload(NotificationCategory.AiInteraction));

    assert.deepEqual(
      tokenRepo.getStoredTokens().map((t) => t.token),
      ["token-b"],
      "the opted-out device's token must survive; only the delivered stale token is removed",
    );
  });

  it("does not query settings when the user has no tokens", async () => {
    const tokenRepo = createMockDeviceTokenRepo([]);
    const messaging = createMockMessaging([]);
    let resolverCalls = 0;
    const settings: NotificationSettingsResolver = {
      resolveNotificationsByDevice: async () => {
        resolverCalls += 1;
        return new Map();
      },
    };
    const service = new NotificationService(tokenRepo.repo, messaging.messaging, settings);

    const result = await service.sendToUser("user-1", buildPayload(NotificationCategory.AiInteraction));

    assert.deepEqual(result, { devicesNotified: 0, retryableFailures: 0 });
    assert.equal(resolverCalls, 0);
  });
});

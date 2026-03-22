import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Messaging } from "firebase-admin/messaging";
import type { DeviceTokenRepository } from "../../src/repositories/device-token-repo.js";
import { NotificationService, type NotificationPayload } from "../../src/services/notification-service.js";

type MockResponse = { success: boolean; error?: { code: string } };
type MockToken = { userId: string; token: string; platform: string };

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

  return {
    repo,
    getStoredTokens: () => [...stored],
  };
}

const payload: NotificationPayload = {
  category: "updates",
  title: "New update",
  body: "You have a new message",
  collapseKey: "updates-collapse",
  data: { screen: "inbox" },
};

describe("NotificationService", () => {
  it("sends to all user tokens and returns success count", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "token-a", platform: "ios" },
      { userId: "user-1", token: "token-b", platform: "android" },
    ]);
    const messaging = createMockMessaging([{ success: true }, { success: true }]);
    const service = new NotificationService(tokenRepo.repo, messaging.messaging);

    const result = await service.sendToUser("user-1", payload);

    assert.deepEqual(result, { devicesNotified: 2 });
    assert.equal(messaging.calls.length, 1);
    assert.equal(messaging.calls[0]?.length, 2);

    const firstMessage = messaging.calls[0]?.[0] as { token?: string };
    const secondMessage = messaging.calls[0]?.[1] as { token?: string };
    assert.equal(firstMessage.token, "token-a");
    assert.equal(secondMessage.token, "token-b");
  });

  it("returns 0 and does not call messaging when user has no tokens", async () => {
    const tokenRepo = createMockDeviceTokenRepo([{ userId: "another-user", token: "token-x", platform: "ios" }]);
    const messaging = createMockMessaging([{ success: true }]);
    const service = new NotificationService(tokenRepo.repo, messaging.messaging);

    const result = await service.sendToUser("user-1", payload);

    assert.deepEqual(result, { devicesNotified: 0 });
    assert.equal(messaging.calls.length, 0);
  });

  it("deletes stale token when Firebase reports not-registered", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "token-live", platform: "ios" },
      { userId: "user-1", token: "token-stale", platform: "android" },
    ]);
    const messaging = createMockMessaging([
      { success: true },
      { success: false, error: { code: "messaging/registration-token-not-registered" } },
    ]);
    const service = new NotificationService(tokenRepo.repo, messaging.messaging);

    const result = await service.sendToUser("user-1", payload);

    assert.deepEqual(result, { devicesNotified: 1 });
    assert.deepEqual(
      tokenRepo.getStoredTokens().map((t) => t.token),
      ["token-live"],
    );
  });

  it("deletes all stale tokens when every send fails with token errors", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "token-stale-a", platform: "ios" },
      { userId: "user-1", token: "token-stale-b", platform: "android" },
    ]);
    const messaging = createMockMessaging([
      { success: false, error: { code: "messaging/registration-token-not-registered" } },
      { success: false, error: { code: "messaging/invalid-registration-token" } },
    ]);
    const service = new NotificationService(tokenRepo.repo, messaging.messaging);

    const result = await service.sendToUser("user-1", payload);

    assert.deepEqual(result, { devicesNotified: 0 });
    assert.deepEqual(tokenRepo.getStoredTokens(), []);
  });

  it("logs non-token Firebase errors and keeps the token", async () => {
    const tokenRepo = createMockDeviceTokenRepo([
      { userId: "user-1", token: "token-live", platform: "ios" },
      { userId: "user-1", token: "token-keep", platform: "android" },
    ]);
    const messaging = createMockMessaging([
      { success: true },
      { success: false, error: { code: "messaging/internal-error" } },
    ]);
    const service = new NotificationService(tokenRepo.repo, messaging.messaging);

    const originalWarn = console.warn;
    const warns: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };

    try {
      const result = await service.sendToUser("user-1", payload);
      assert.deepEqual(result, { devicesNotified: 1 });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warns.length, 1);
    assert.deepEqual(
      tokenRepo.getStoredTokens().map((t) => t.token),
      ["token-live", "token-keep"],
    );
  });

  it("returns 0 when Firebase messaging is not configured", async () => {
    const tokenRepo = createMockDeviceTokenRepo([{ userId: "user-1", token: "token-a", platform: "ios" }]);
    const service = new NotificationService(tokenRepo.repo, null);

    const result = await service.sendToUser("user-1", payload);

    assert.deepEqual(result, { devicesNotified: 0 });
  });
});

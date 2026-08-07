import { createHash } from "node:crypto";
import type { Messaging, BaseMessage } from "firebase-admin/messaging";
import { NOTIFICATION_CATEGORY_SETTING_KEYS, NotificationCategory } from "../models/notification.js";
import { NOTIFICATION_SETTINGS_DEFAULTS, type NotificationSettings } from "../models/settings.js";
import type { DeviceToken } from "../models/documents.js";
import type { DeviceTokenRepository } from "../repositories/device-token-repo.js";

export interface NotificationData {
  category: string;
  eventType?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
}

export interface NotificationPayload {
  category: NotificationCategory;
  title: string;
  body: string;
  collapseKey?: string | null;
  data?: NotificationData | null;
}

export interface NotificationSettingsResolver {
  resolveNotificationsByDevice(userId: string): Promise<Map<string, NotificationSettings>>;
}

export interface NotificationDeliveryResult {
  devicesNotified: number;
  retryableFailures: number;
}

export class NotificationService {
  readonly #deviceTokenRepo: DeviceTokenRepository;
  readonly #messaging: Messaging | null;
  readonly #settingsResolver: NotificationSettingsResolver;

  constructor(
    deviceTokenRepo: DeviceTokenRepository,
    messaging: Messaging | null,
    settingsResolver: NotificationSettingsResolver,
  ) {
    this.#deviceTokenRepo = deviceTokenRepo;
    this.#messaging = messaging;
    this.#settingsResolver = settingsResolver;
  }

  // A token with no deviceId predates per-device settings and cannot be matched
  // to a stored preference, so it keeps delivering rather than going silent.
  async #selectOptedInTokens(userId: string, tokens: DeviceToken[], category: NotificationCategory) {
    // Until clients send deviceId, every token fails open, so the settings read
    // cannot change the outcome and is skipped on the whole push path.
    if (!tokens.some((deviceToken) => deviceToken.deviceId)) {
      return tokens;
    }

    const settingKey = NOTIFICATION_CATEGORY_SETTING_KEYS[category];

    let settingsByDevice: Map<string, NotificationSettings>;
    try {
      settingsByDevice = await this.#settingsResolver.resolveNotificationsByDevice(userId);
    } catch (error) {
      // Same rule as an unmatched token: an unreadable preference is not proof
      // of an opt-out, and muting every device is worse than over-delivering.
      console.warn("Failed to read notification settings; delivering unfiltered", { userId, error });
      return tokens;
    }

    return tokens.filter((deviceToken) => {
      if (!deviceToken.deviceId) {
        return true;
      }

      const settings = settingsByDevice.get(deviceToken.deviceId) ?? NOTIFICATION_SETTINGS_DEFAULTS;
      return settings[settingKey];
    });
  }

  get isAvailable(): boolean {
    return this.#messaging !== null;
  }

  async sendToUser(
    userId: string,
    payload: NotificationPayload,
    abortSignal?: AbortSignal,
  ): Promise<NotificationDeliveryResult> {
    return this.#deliver(userId, payload, abortSignal, true);
  }

  // Activation reminders are lifecycle nudges about finishing setup, not the
  // product "System Updates" the toggle describes, so they are deliberately not
  // silenced by it even though they ride the same category on the wire.
  async sendToUserIgnoringDeviceSettings(
    userId: string,
    payload: NotificationPayload,
    abortSignal?: AbortSignal,
  ): Promise<NotificationDeliveryResult> {
    return this.#deliver(userId, payload, abortSignal, false);
  }

  async #deliver(
    userId: string,
    payload: NotificationPayload,
    abortSignal: AbortSignal | undefined,
    respectDeviceSettings: boolean,
  ): Promise<NotificationDeliveryResult> {
    abortSignal?.throwIfAborted();
    if (!this.#messaging) {
      return { devicesNotified: 0, retryableFailures: 0 };
    }

    const tokens = await this.#deviceTokenRepo.findByUserId(userId);
    abortSignal?.throwIfAborted();
    if (tokens.length === 0) {
      return { devicesNotified: 0, retryableFailures: 0 };
    }

    const deliverableTokens = respectDeviceSettings
      ? await this.#selectOptedInTokens(userId, tokens, payload.category)
      : tokens;
    abortSignal?.throwIfAborted();
    if (deliverableTokens.length === 0) {
      return { devicesNotified: 0, retryableFailures: 0 };
    }

    // FCM data must be a flat Record<string, string>. Flatten NotificationData and filter nulls.
    // The enum-validated top-level category is the only outbound category.
    // data.category is a free string, so honouring it would emit a category the
    // device opted out of — or a server-only one — after filtering already ran.
    const flatData: Record<string, string> = { category: payload.category };
    if (payload.data) {
      if (payload.data.eventType) flatData["eventType"] = payload.data.eventType;
      if (payload.data.sessionId) flatData["sessionId"] = payload.data.sessionId;
      if (payload.data.projectId) flatData["projectId"] = payload.data.projectId;
    }

    const messages: Array<BaseMessage & { token: string }> = deliverableTokens.map((t) => ({
      token: t.token,
      notification: { title: payload.title, body: payload.body },
      data: flatData,
      android: {
        collapseKey: payload.collapseKey ?? undefined,
        // Android ignores collapseKey for already-displayed notification messages;
        // the tag is what replaces/dismisses the visible notification per session.
        notification: { channelId: payload.category, tag: payload.collapseKey || undefined },
      },
      apns: {
        headers: payload.collapseKey ? { "apns-collapse-id": payload.collapseKey } : undefined,
      },
    }));

    const response = await this.#messaging.sendEach(messages);
    abortSignal?.throwIfAborted();

    const staleTokens: string[] = [];
    let retryableFailures = 0;
    response.responses.forEach((r, i) => {
      if (r.success) {
        return;
      }

      const code = r.error?.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        staleTokens.push(deliverableTokens[i].token);
        return;
      }

      retryableFailures += 1;
      const tokenFingerprint = createHash("sha256").update(deliverableTokens[i].token).digest("hex").slice(0, 12);
      console.warn("Non-token FCM error while sending push notification", { userId, tokenFingerprint, code });
    });

    if (staleTokens.length > 0) {
      await this.#deviceTokenRepo.deleteByTokens(staleTokens);
      abortSignal?.throwIfAborted();
    }

    return { devicesNotified: response.successCount, retryableFailures };
  }
}

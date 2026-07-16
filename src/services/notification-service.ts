import { createHash } from "node:crypto";
import type { Messaging, BaseMessage } from "firebase-admin/messaging";
import type { DeviceTokenRepository } from "../repositories/device-token-repo.js";

export interface NotificationData {
  category: string;
  eventType?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
}

export interface NotificationPayload {
  category: string;
  title: string;
  body: string;
  collapseKey?: string | null;
  data?: NotificationData | null;
}

export interface NotificationDeliveryResult {
  devicesNotified: number;
  retryableFailures: number;
}

export class NotificationService {
  readonly #deviceTokenRepo: DeviceTokenRepository;
  readonly #messaging: Messaging | null;

  constructor(deviceTokenRepo: DeviceTokenRepository, messaging: Messaging | null) {
    this.#deviceTokenRepo = deviceTokenRepo;
    this.#messaging = messaging;
  }

  get isAvailable(): boolean {
    return this.#messaging !== null;
  }

  async sendToUser(
    userId: string,
    payload: NotificationPayload,
    abortSignal?: AbortSignal,
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

    // FCM data must be a flat Record<string, string>. Flatten NotificationData and filter nulls.
    const flatData: Record<string, string> = { category: payload.category };
    if (payload.data) {
      if (payload.data.category) flatData["category"] = payload.data.category;
      if (payload.data.eventType) flatData["eventType"] = payload.data.eventType;
      if (payload.data.sessionId) flatData["sessionId"] = payload.data.sessionId;
      if (payload.data.projectId) flatData["projectId"] = payload.data.projectId;
    }

    const messages: Array<BaseMessage & { token: string }> = tokens.map((t) => ({
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
        staleTokens.push(tokens[i].token);
        return;
      }

      retryableFailures += 1;
      const tokenFingerprint = createHash("sha256").update(tokens[i].token).digest("hex").slice(0, 12);
      console.warn("Non-token FCM error while sending push notification", { userId, tokenFingerprint, code });
    });

    if (staleTokens.length > 0) {
      await this.#deviceTokenRepo.deleteByTokens(staleTokens);
      abortSignal?.throwIfAborted();
    }

    return { devicesNotified: response.successCount, retryableFailures };
  }
}

import type { Messaging, BaseMessage } from "firebase-admin/messaging";
import type { DeviceTokenRepository } from "../repositories/device-token-repo.js";

export interface NotificationPayload {
  category: string;
  title: string;
  body: string;
  collapseKey?: string;
  data?: Record<string, string>;
}

export class NotificationService {
  readonly #deviceTokenRepo: DeviceTokenRepository;
  readonly #messaging: Messaging | null;

  constructor(deviceTokenRepo: DeviceTokenRepository, messaging: Messaging | null) {
    this.#deviceTokenRepo = deviceTokenRepo;
    this.#messaging = messaging;
  }

  async sendToUser(userId: string, payload: NotificationPayload): Promise<{ devicesNotified: number }> {
    if (!this.#messaging) {
      return { devicesNotified: 0 };
    }

    const tokens = await this.#deviceTokenRepo.findByUserId(userId);
    if (tokens.length === 0) {
      return { devicesNotified: 0 };
    }

    const messages: Array<BaseMessage & { token: string }> = tokens.map((t) => ({
      token: t.token,
      notification: { title: payload.title, body: payload.body },
      data: { category: payload.category, ...payload.data },
      android: {
        collapseKey: payload.collapseKey,
        notification: { channelId: payload.category },
      },
      apns: {
        headers: payload.collapseKey ? { "apns-collapse-id": payload.collapseKey } : undefined,
      },
    }));

    const response = await this.#messaging.sendEach(messages);

    const staleTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (!r.error) {
        return;
      }

      const code = r.error.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        staleTokens.push(tokens[i].token);
        return;
      }

      console.warn("Non-token FCM error while sending push notification", { userId, token: tokens[i].token, code });
    });

    if (staleTokens.length > 0) {
      await this.#deviceTokenRepo.deleteByTokens(staleTokens);
    }

    return { devicesNotified: response.successCount };
  }
}

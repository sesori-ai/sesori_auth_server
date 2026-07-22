import { BadRequestError } from "../lib/errors.js";
import type { SettingsConfiguration } from "../models/documents.js";
import {
  resolveNotificationSettings,
  type SettingsConfigurationView,
  type UpdateSettingsBody,
} from "../models/settings.js";
import type { SettingsConfigurationRepository } from "../repositories/settings-configuration-repo.js";

// Bounds the settings collection against a client that mints deviceIds to spam
// documents. Mirrors the 50-bridges cap; a legitimate user stays far below it.
const MAX_DEVICES_PER_USER = 50;

function toView(deviceId: string, document: SettingsConfiguration | null): SettingsConfigurationView {
  return {
    deviceId,
    notifications: resolveNotificationSettings(document?.notifications),
    updatedAt: document?.updatedAt ? document.updatedAt.toISOString() : null,
  };
}

export class SettingsService {
  readonly #repo: SettingsConfigurationRepository;

  constructor(deps: { settingsRepo: SettingsConfigurationRepository }) {
    this.#repo = deps.settingsRepo;
  }

  async getForDevice(userId: string, deviceId: string): Promise<SettingsConfigurationView> {
    const document = await this.#repo.findByUserAndDevice(userId, deviceId);
    return toView(deviceId, document);
  }

  async updateForDevice(
    userId: string,
    deviceId: string,
    patch: UpdateSettingsBody,
  ): Promise<SettingsConfigurationView> {
    // Cap only new devices. The pre-check is best-effort (no DB constraint backs
    // it), which is acceptable for a payload-size guard: the worst case is a
    // handful of extra documents under a concurrent burst, never unbounded growth.
    const existing = await this.#repo.findByUserAndDevice(userId, deviceId);
    if (!existing) {
      const deviceCount = await this.#repo.countByUserId(userId);
      if (deviceCount >= MAX_DEVICES_PER_USER) {
        throw new BadRequestError({ debugMessage: "Device settings limit reached for user" });
      }
    }

    const document = await this.#repo.upsert(userId, deviceId, patch);
    return toView(deviceId, document);
  }
}

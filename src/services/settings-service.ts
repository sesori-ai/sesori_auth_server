import type { SettingsConfiguration } from "../models/documents.js";
import {
  resolveNotificationSettings,
  type NotificationSettings,
  type SettingsConfigurationView,
  type UpdateSettingsBody,
} from "../models/settings.js";
import type { SettingsConfigurationRepository } from "../repositories/settings-configuration-repo.js";

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

  // Devices absent from the returned map have stored nothing and therefore
  // resolve to the all-enabled defaults at the call site.
  async resolveNotificationsByDevice(userId: string): Promise<Map<string, NotificationSettings>> {
    const documents = await this.#repo.findByUserId(userId);
    return new Map(
      documents.map((document) => [document.deviceId, resolveNotificationSettings(document.notifications)]),
    );
  }

  async updateForDevice(
    userId: string,
    deviceId: string,
    patch: UpdateSettingsBody,
  ): Promise<SettingsConfigurationView> {
    const document = await this.#repo.upsert(userId, deviceId, patch);
    return toView(deviceId, document);
  }

  // Drops every device's stored overrides for the account, leaving each one
  // resolving to the same server defaults a read returns for a device that never
  // stored anything.
  async deleteAllForUser(userId: string): Promise<void> {
    await this.#repo.deleteAllForUser(userId);
  }
}

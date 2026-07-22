import type { SettingsConfiguration } from "../models/documents.js";
import {
  resolveNotificationSettings,
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

  async updateForDevice(
    userId: string,
    deviceId: string,
    patch: UpdateSettingsBody,
  ): Promise<SettingsConfigurationView> {
    const document = await this.#repo.upsert(userId, deviceId, patch);
    return toView(deviceId, document);
  }
}

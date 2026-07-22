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
    const existing = await this.#repo.findByUserAndDevice(userId, deviceId);
    if (!existing) {
      const devices = await this.#repo.findByUserId(userId);
      if (devices.length >= MAX_DEVICES_PER_USER) {
        throw new BadRequestError({ debugMessage: "Device settings limit reached for user" });
      }
    }

    const document = await this.#repo.upsert(userId, deviceId, patch);

    // The pre-insert count above is racy (no DB constraint backs the cap), so a
    // concurrent burst of distinct new deviceIds can overshoot it. Re-rank after
    // the insert and self-delete only when THIS device falls past the cap in
    // (createdAt, deviceId) order: the deterministic order means contenders
    // cannot all self-delete (the earliest always keeps its slot), so a burst
    // admits exactly the remaining capacity once reads settle. Mirrors bridge
    // registration; enforcement stays best-effort under extreme interleaving.
    if (!existing) {
      const after = await this.#repo.findByUserId(userId);
      if (after.length > MAX_DEVICES_PER_USER) {
        const ranked = [...after].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.deviceId < b.deviceId ? -1 : 1),
        );
        const overflow = ranked.slice(MAX_DEVICES_PER_USER);
        if (overflow.some((device) => device.deviceId === deviceId)) {
          await this.#repo.deleteByUserAndDevice(userId, deviceId);
          throw new BadRequestError({ debugMessage: "Device settings limit reached for user" });
        }
      }
    }

    return toView(deviceId, document);
  }
}

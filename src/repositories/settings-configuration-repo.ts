import { Collection, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { SettingsConfiguration } from "../models/documents.js";
import type { UpdateSettingsBody } from "../models/settings.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

export class SettingsConfigurationRepository {
  readonly #collection: Collection<SettingsConfiguration>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<SettingsConfiguration>(
      MongoDbDatabase.Auth,
      AuthDbCollection.SettingsConfiguration,
    );
  }

  // Served by the (userId, deviceId) unique index as a prefix scan, so one
  // notification send costs a single lookup instead of one per device.
  async findByUserId(userId: string): Promise<SettingsConfiguration[]> {
    if (!ObjectId.isValid(userId)) {
      return [];
    }

    return this.#collection.find({ userId: new ObjectId(userId) }).toArray();
  }

  async findByUserAndDevice(userId: string, deviceId: string): Promise<SettingsConfiguration | null> {
    if (!ObjectId.isValid(userId)) {
      return null;
    }

    return this.#collection.findOne({ userId: new ObjectId(userId), deviceId });
  }

  // Create-or-merge scoped by (userId, deviceId): only the toggles present in the
  // patch are written, as dotted paths, so a single-toggle change never clobbers
  // the device's other stored toggles. The filter's equality fields seed userId
  // and deviceId on insert; $ifNull keeps the original createdAt on update.
  async upsert(userId: string, deviceId: string, patch: UpdateSettingsBody): Promise<SettingsConfiguration> {
    if (!ObjectId.isValid(userId)) {
      throw new InternalServerError({ debugMessage: "Invalid settings userId" });
    }

    const now = new Date();
    const set: Record<string, unknown> = {
      updatedAt: now,
      createdAt: { $ifNull: ["$createdAt", now] },
    };
    if (patch.notifications) {
      for (const [key, value] of Object.entries(patch.notifications)) {
        if (value !== undefined) {
          set[`notifications.${key}`] = value;
        }
      }
    }

    const document = await this.#collection.findOneAndUpdate(
      { userId: new ObjectId(userId), deviceId },
      [{ $set: set }],
      { upsert: true, returnDocument: "after" },
    );
    if (!document) {
      throw new InternalServerError({ debugMessage: "Settings upsert returned no document" });
    }

    return document;
  }

  // Scoped by userId as well as deviceId so a leaked deviceId cannot clear
  // another account's settings. Deleting a device that stored nothing is a
  // no-op rather than an error: reads already resolve an absent document to the
  // defaults, so the caller's end state is identical either way.
  async deleteByUserAndDevice(userId: string, deviceId: string): Promise<void> {
    if (!ObjectId.isValid(userId)) {
      throw new InternalServerError({ debugMessage: "Invalid settings userId" });
    }

    await this.#collection.deleteOne({ userId: new ObjectId(userId), deviceId });
  }

  // For account deletion: every device's record goes, which the (userId,
  // deviceId) unique index serves as a prefix scan. Deliberately NOT wired into
  // logout, even though deviceTokens are cleared there. Settings are a
  // preference the same user expects to still have after signing back in.
  async deleteAllForUser(userId: string): Promise<void> {
    if (!ObjectId.isValid(userId)) {
      throw new InternalServerError({ debugMessage: "Invalid settings userId" });
    }

    await this.#collection.deleteMany({ userId: new ObjectId(userId) });
  }
}

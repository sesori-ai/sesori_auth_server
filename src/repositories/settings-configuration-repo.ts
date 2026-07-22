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
}

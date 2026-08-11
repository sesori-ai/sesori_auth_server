import { Collection, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { DevicePlatform } from "../models/device.js";
import type { DeviceToken } from "../models/documents.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

export class DeviceTokenRepository {
  readonly #collection: Collection<DeviceToken>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<DeviceToken>(MongoDbDatabase.Auth, AuthDbCollection.DeviceTokens);
  }

  async upsertToken(userId: string, token: string, platform: DevicePlatform, deviceId?: string): Promise<void> {
    if (!ObjectId.isValid(userId)) {
      throw new InternalServerError({ debugMessage: "Invalid device token userId" });
    }
    const now = new Date();
    const objectUserId = new ObjectId(userId);
    const sameOwner = { $eq: ["$userId", objectUserId] };
    // Concurrent writes to one token serialize, so these predicates inspect the
    // owner left by the preceding write. Same-owner platform changes preserve
    // the first app-registration timestamp; ownership changes reset it.
    await this.#collection.updateOne(
      { token },
      [
        {
          $set: {
            userId: objectUserId,
            platform,
            // A client that omits deviceId must not erase a previously learned
            // one, but a new owner must not inherit the old owner's device.
            deviceId: deviceId ?? { $cond: [sameOwner, { $ifNull: ["$deviceId", null] }, null] },
            createdAt: {
              $cond: [sameOwner, { $ifNull: ["$createdAt", now] }, now],
            },
            updatedAt: now,
          },
        },
      ],
      { upsert: true },
    );
  }

  async findByUserId(userId: string): Promise<DeviceToken[]> {
    return this.#collection.find({ userId: new ObjectId(userId) }).toArray();
  }

  async hasAnyForUser(userId: string): Promise<boolean> {
    if (!ObjectId.isValid(userId)) {
      throw new InternalServerError({ debugMessage: "Invalid device token userId" });
    }

    return (await this.#collection.findOne({ userId: new ObjectId(userId) }, { projection: { _id: 1 } })) !== null;
  }

  async findEarliestCreatedAt(userId: string): Promise<Date | null> {
    if (!ObjectId.isValid(userId)) {
      return null;
    }

    const token = await this.#collection.findOne({ userId: new ObjectId(userId) }, { sort: { createdAt: 1 } });
    return token?.createdAt ?? null;
  }

  async deleteByToken(token: string): Promise<void> {
    await this.#collection.deleteOne({ token });
  }

  async deleteByTokenForUser(userId: string, token: string): Promise<void> {
    await this.#collection.deleteOne({ token, userId: new ObjectId(userId) });
  }

  async deleteByTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.#collection.deleteMany({ token: { $in: tokens } });
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.#collection.deleteMany({ userId: new ObjectId(userId) });
  }
}

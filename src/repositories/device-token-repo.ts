import { Collection, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import { isMobileDevicePlatform, MOBILE_DEVICE_PLATFORMS, type DevicePlatform } from "../models/device.js";
import type { DeviceToken } from "../models/documents.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

export class DeviceTokenRepository {
  readonly #collection: Collection<DeviceToken>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<DeviceToken>(MongoDbDatabase.Auth, AuthDbCollection.DeviceTokens);
  }

  async upsertToken(userId: string, token: string, platform: DevicePlatform): Promise<void> {
    if (!ObjectId.isValid(userId)) {
      throw new InternalServerError({ debugMessage: "Invalid device token userId" });
    }
    const now = new Date();
    const objectUserId = new ObjectId(userId);
    const sameOwner = { $eq: ["$userId", objectUserId] };
    // Concurrent writes to one token serialize, so these predicates inspect the
    // owner/platform left by the preceding write. Ownership changes and
    // same-owner desktop-to-mobile transitions reset the qualifying timestamp;
    // all other same-owner platform changes preserve it.
    const preserveCreatedAt = isMobileDevicePlatform(platform)
      ? { $and: [sameOwner, { $in: ["$platform", MOBILE_DEVICE_PLATFORMS] }] }
      : sameOwner;
    await this.#collection.updateOne(
      { token },
      [
        {
          $set: {
            userId: objectUserId,
            platform,
            createdAt: {
              $cond: [preserveCreatedAt, { $ifNull: ["$createdAt", now] }, now],
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

  async findEarliestMobileCreatedAt(userId: string): Promise<Date | null> {
    if (!ObjectId.isValid(userId)) return null;
    const token = await this.#collection.findOne(
      { userId: new ObjectId(userId), platform: { $in: MOBILE_DEVICE_PLATFORMS } },
      { sort: { createdAt: 1 } },
    );
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

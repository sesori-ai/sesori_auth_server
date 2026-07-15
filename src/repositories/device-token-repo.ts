import { Collection, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import type { DeviceToken } from "../models/documents.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

export class DeviceTokenRepository {
  readonly #collection: Collection<DeviceToken>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<DeviceToken>(MongoDbDatabase.Auth, AuthDbCollection.DeviceTokens);
  }

  async upsertToken(userId: string, token: string, platform: "ios" | "android"): Promise<void> {
    if (!ObjectId.isValid(userId)) {
      throw new Error("Invalid userId");
    }
    const now = new Date();
    const objectUserId = new ObjectId(userId);
    await this.#collection.updateOne(
      { token },
      [
        {
          $set: {
            userId: objectUserId,
            platform,
            // A token moved to another account is a new registration for that
            // user; same-user retries retain the original setup timestamp.
            createdAt: {
              $cond: [{ $eq: ["$userId", objectUserId] }, { $ifNull: ["$createdAt", now] }, now],
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

  async findEarliestCreatedAt(userId: string): Promise<Date | null> {
    if (!ObjectId.isValid(userId)) return null;
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

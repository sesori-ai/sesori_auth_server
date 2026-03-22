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
    const now = new Date();
    await this.#collection.updateOne(
      { token },
      {
        $set: { userId: new ObjectId(userId), platform, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  async findByUserId(userId: string): Promise<DeviceToken[]> {
    return this.#collection.find({ userId: new ObjectId(userId) }).toArray();
  }

  async deleteByToken(token: string): Promise<void> {
    await this.#collection.deleteOne({ token });
  }

  async deleteByTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.#collection.deleteMany({ token: { $in: tokens } });
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.#collection.deleteMany({ userId: new ObjectId(userId) });
  }
}

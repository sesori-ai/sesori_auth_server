import crypto from "node:crypto";
import { Collection, ObjectId } from "mongodb";
import type { Bridge } from "../models/documents.js";
import type { BridgePlatform } from "../models/api.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";

export type RegisterBridgeInput = {
  userId: string;
  name: string;
  platform: BridgePlatform;
};

export class BridgeRepository {
  readonly #collection: Collection<Bridge>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<Bridge>(MongoDbDatabase.Auth, AuthDbCollection.Bridges);
  }

  static generateBridgeId(): string {
    return `br_${crypto.randomBytes(12).toString("base64url")}`;
  }

  async findById(bridgeId: string): Promise<Bridge | null> {
    return this.#collection.findOne({ bridgeId });
  }

  async findByIdForUser(bridgeId: string, userId: string): Promise<Bridge | null> {
    if (!ObjectId.isValid(userId)) {
      return null;
    }

    return this.#collection.findOne({
      bridgeId,
      userId: new ObjectId(userId),
      revokedAt: null,
    });
  }

  async findByUserId(userId: string): Promise<Bridge[]> {
    if (!ObjectId.isValid(userId)) {
      return [];
    }

    return this.#collection
      .find({
        userId: new ObjectId(userId),
        revokedAt: null,
      })
      .toArray();
  }

  async register(input: RegisterBridgeInput): Promise<Bridge> {
    if (!ObjectId.isValid(input.userId)) {
      throw new Error("Invalid userId");
    }

    const now = new Date();
    const bridge: Bridge = {
      _id: new ObjectId(),
      bridgeId: BridgeRepository.generateBridgeId(),
      userId: new ObjectId(input.userId),
      name: input.name,
      platform: input.platform,
      status: "inactive",
      addedAt: now,
      lastSeenAt: null,
      lastSeenIp: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#collection.insertOne(bridge);
    return bridge;
  }

  async recordStatusChange(
    bridgeId: string,
    userId: string,
    status: "active" | "inactive",
    at: Date,
  ): Promise<boolean> {
    if (!ObjectId.isValid(userId)) {
      return false;
    }

    const result = await this.#collection.updateOne(
      { bridgeId, userId: new ObjectId(userId), revokedAt: null },
      {
        $set: { status, lastSeenAt: at, updatedAt: at },
      },
    );
    return result.modifiedCount === 1;
  }

  async revoke(bridgeId: string, userId: string, at: Date): Promise<boolean> {
    if (!ObjectId.isValid(userId)) {
      return false;
    }

    const result = await this.#collection.updateOne(
      {
        bridgeId,
        userId: new ObjectId(userId),
        revokedAt: null,
      },
      {
        $set: { status: "inactive", revokedAt: at, updatedAt: at },
      },
    );
    return result.modifiedCount === 1;
  }
}

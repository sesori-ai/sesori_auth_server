import crypto from "node:crypto";
import { Collection, ObjectId } from "mongodb";
import type { Bridge } from "../models/documents.js";
import { BridgeStatus, type BridgePlatform } from "../models/bridge.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";

export type RegisterBridgeInput = {
  userId: string;
  name: string;
  platform: BridgePlatform;
};

export type RecordBridgeStatusResult = {
  /** False when the bridge is unknown, revoked, or owned by another user. */
  found: boolean;
  /** True when the event was applied (not dropped by the monotonic guard). */
  updated: boolean;
  statusChanged: boolean;
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
      status: BridgeStatus.inactive,
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

  // Owner-scoped idempotent re-registration: updates name/platform on a
  // non-revoked bridge. Returns null when the bridge is unknown, revoked, or
  // owned by another user (caller falls back to minting a new bridge).
  async updateForUser(
    bridgeId: string,
    userId: string,
    update: { name: string; platform: BridgePlatform },
  ): Promise<Bridge | null> {
    if (!ObjectId.isValid(userId)) {
      return null;
    }

    return this.#collection.findOneAndUpdate(
      {
        bridgeId,
        userId: new ObjectId(userId),
        revokedAt: null,
      },
      {
        $set: { name: update.name, platform: update.platform, updatedAt: new Date() },
      },
      { returnDocument: "after" },
    );
  }

  // Single atomic round trip on the relay's hot path: the filter alone
  // decides existence (null => unknown/foreign/revoked => the route answers
  // 404), while the monotonic lastSeenAt guard moves into the update pipeline
  // so a stale (out-of-order) event still matches the document but writes
  // nothing. $lte, not $lt: a status flip carrying the same millisecond
  // timestamp must still apply — re-applying an identical event is idempotent.
  async recordStatusChange(
    bridgeId: string,
    userId: string,
    status: BridgeStatus,
    at: Date,
  ): Promise<RecordBridgeStatusResult> {
    if (!ObjectId.isValid(userId)) {
      return { found: false, updated: false, statusChanged: false };
    }

    const applyCond = {
      $or: [{ $eq: ["$lastSeenAt", null] }, { $lte: ["$lastSeenAt", at] }],
    };
    const before = await this.#collection.findOneAndUpdate(
      {
        bridgeId,
        userId: new ObjectId(userId),
        revokedAt: null,
      },
      [
        {
          $set: {
            status: { $cond: [applyCond, status, "$status"] },
            lastSeenAt: { $cond: [applyCond, at, "$lastSeenAt"] },
            updatedAt: { $cond: [applyCond, at, "$updatedAt"] },
          },
        },
      ],
      { returnDocument: "before" },
    );
    if (!before) {
      return { found: false, updated: false, statusChanged: false };
    }

    const applied = before.lastSeenAt === null || before.lastSeenAt.getTime() <= at.getTime();
    return {
      found: true,
      updated: applied,
      statusChanged: applied && before.status !== status,
    };
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
        $set: { status: BridgeStatus.inactive, revokedAt: at, updatedAt: at },
      },
    );
    return result.modifiedCount === 1;
  }

  async revokeAllForUser(userId: string, at: Date): Promise<Bridge[]> {
    if (!ObjectId.isValid(userId)) {
      return [];
    }

    const filter = { userId: new ObjectId(userId), revokedAt: null };
    const bridges = await this.#collection.find(filter).toArray();
    if (bridges.length === 0) {
      return [];
    }

    await this.#collection.updateMany(filter, {
      $set: { status: BridgeStatus.inactive, revokedAt: at, updatedAt: at },
    });
    return bridges;
  }
}

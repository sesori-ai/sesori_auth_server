import crypto from "node:crypto";
import { Collection, ObjectId, type Filter } from "mongodb";
import type { Bridge } from "../models/documents.js";
import { BridgeStatus, type BridgeKind, type BridgePlatform } from "../models/bridge.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";

export type RegisterBridgeInput = {
  userId: string;
  name: string;
  platform: BridgePlatform;
  hostKey: string | null;
  kind?: BridgeKind;
};

export type BridgeRegistrationUpdate = {
  name: string;
  platform: BridgePlatform;
  /** Stored only when non-null; null leaves any stored key unchanged. */
  hostKey: string | null;
  /** Stored only when present; older bridges leave any stored kind unchanged. */
  kind?: BridgeKind;
};

// found=false when the bridge is unknown, revoked, or owned by another user.
export type RecordBridgeStatusResult =
  | { found: false }
  | {
      found: true;
      /** True when the event was applied (not dropped by the monotonic guard). */
      updated: boolean;
      statusChanged: boolean;
      name: string;
      nickname: string | null;
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

  async findRevokedIdsForUser(args: { userId: string; bridgeIds: string[] }): Promise<string[]> {
    if (!ObjectId.isValid(args.userId) || args.bridgeIds.length === 0) {
      return [];
    }

    const bridges = await this.#collection
      .find({
        userId: new ObjectId(args.userId),
        bridgeId: { $in: args.bridgeIds },
        revokedAt: { $ne: null },
      })
      .sort({ bridgeId: 1 })
      .toArray();
    return bridges.map((bridge) => bridge.bridgeId);
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

  async findEarliestAddedAt(userId: string): Promise<Date | null> {
    if (!ObjectId.isValid(userId)) return null;
    const bridge = await this.#collection.findOne({ userId: new ObjectId(userId) }, { sort: { addedAt: 1 } });
    return bridge?.addedAt ?? null;
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
      ...(input.hostKey ? { hostKey: input.hostKey } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
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

  // Owner-scoped idempotent re-registration: updates name/platform (and a
  // supplied hostKey) on a non-revoked bridge. Returns null when the bridge is
  // unknown, revoked, or owned by another user (caller falls back to a host-key
  // match or minting a new bridge).
  async updateForUser(bridgeId: string, userId: string, update: BridgeRegistrationUpdate): Promise<Bridge | null> {
    return this.#updateRegistration({ userId, filter: { bridgeId }, update });
  }

  // Reinstall on the same computer: updates the caller's non-revoked bridge
  // carrying this hostKey, most recently seen first when clones share a key.
  async updateByHostKeyForUser(args: {
    hostKey: string;
    userId: string;
    update: BridgeRegistrationUpdate;
  }): Promise<Bridge | null> {
    return this.#updateRegistration({
      userId: args.userId,
      filter: { hostKey: args.hostKey },
      update: args.update,
    });
  }

  async #updateRegistration(args: {
    userId: string;
    filter: Filter<Bridge>;
    update: BridgeRegistrationUpdate;
  }): Promise<Bridge | null> {
    if (!ObjectId.isValid(args.userId)) {
      return null;
    }

    return this.#collection.findOneAndUpdate(
      {
        ...args.filter,
        userId: new ObjectId(args.userId),
        revokedAt: null,
      },
      {
        $set: {
          name: args.update.name,
          platform: args.update.platform,
          ...(args.update.hostKey ? { hostKey: args.update.hostKey } : {}),
          ...(args.update.kind ? { kind: args.update.kind } : {}),
          updatedAt: new Date(),
        },
      },
      // Only a shared hostKey can match several bridges; bridgeId is unique.
      { returnDocument: "after", sort: { lastSeenAt: -1, addedAt: -1 } },
    );
  }

  // First write wins, and only the owner's bridge can match. Revoked bridges
  // still match: the session really did start there.
  async recordFirstSession(args: { bridgeId: string; userId: string; at: Date }): Promise<void> {
    if (!ObjectId.isValid(args.userId)) {
      return;
    }

    await this.#collection.updateOne(
      { bridgeId: args.bridgeId, userId: new ObjectId(args.userId), firstSessionAt: { $exists: false } },
      { $set: { firstSessionAt: args.at, updatedAt: args.at } },
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
      return { found: false };
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
      return { found: false };
    }

    const applied = !before.lastSeenAt || before.lastSeenAt.getTime() <= at.getTime();
    return {
      found: true,
      updated: applied,
      statusChanged: applied && before.status !== status,
      name: before.name,
      nickname: before.nickname ?? null,
    };
  }

  // Sets the nickname, or removes the field when null. Returns null when the
  // bridge is unknown, revoked, or owned by another user.
  async setNicknameForUser(args: {
    bridgeId: string;
    userId: string;
    nickname: string | null;
  }): Promise<Bridge | null> {
    if (!ObjectId.isValid(args.userId)) {
      return null;
    }

    const now = new Date();
    return this.#collection.findOneAndUpdate(
      {
        bridgeId: args.bridgeId,
        userId: new ObjectId(args.userId),
        revokedAt: null,
      },
      args.nickname
        ? { $set: { nickname: args.nickname, updatedAt: now } }
        : { $set: { updatedAt: now }, $unset: { nickname: "" } },
      { returnDocument: "after" },
    );
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

    // Flip first, then snapshot by the exact revocation timestamp: a bridge
    // registered between the two queries remains active and is excluded.
    const objectUserId = new ObjectId(userId);
    await this.#collection.updateMany(
      { userId: objectUserId, revokedAt: null },
      { $set: { status: BridgeStatus.inactive, revokedAt: at, updatedAt: at } },
    );
    return this.#collection.find({ userId: objectUserId, revokedAt: at }).toArray();
  }
}

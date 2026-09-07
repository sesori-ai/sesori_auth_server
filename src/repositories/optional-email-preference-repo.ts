import { Collection, MongoServerError, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { OptionalEmailPreference } from "../models/documents.js";
import { OptionalEmailBlockReason, OptionalEmailSuppressionReason } from "../types/optional-email.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

export class OptionalEmailPreferenceRepository {
  readonly #collection: Collection<OptionalEmailPreference>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<OptionalEmailPreference>(
      MongoDbDatabase.Auth,
      AuthDbCollection.OptionalEmailPreferences,
    );
  }

  async findByUserId(input: { userId: string }): Promise<OptionalEmailPreference | null> {
    if (!ObjectId.isValid(input.userId)) {
      return null;
    }

    return this.#collection.findOne({ userId: new ObjectId(input.userId) });
  }

  async findBlockReason(input: { userId: string }): Promise<OptionalEmailBlockReason | null> {
    const preference = await this.findByUserId(input);
    if (preference?.unsubscribedAt) {
      return OptionalEmailBlockReason.Unsubscribed;
    }
    if (preference?.suppressedAt) {
      return OptionalEmailBlockReason.Suppressed;
    }
    return null;
  }

  async unsubscribe(input: { userId: string; at: Date }): Promise<OptionalEmailPreference> {
    this.#assertInput({ userId: input.userId, at: input.at });
    return this.#upsertOnce({
      userId: input.userId,
      at: input.at,
      fields: {
        unsubscribedAt: { $ifNull: ["$unsubscribedAt", input.at] },
      },
    });
  }

  async suppress(input: {
    userId: string;
    reason: OptionalEmailSuppressionReason;
    at: Date;
  }): Promise<OptionalEmailPreference> {
    this.#assertInput({ userId: input.userId, at: input.at });
    if (!Object.values(OptionalEmailSuppressionReason).includes(input.reason)) {
      throw new InternalServerError({ debugMessage: "Invalid optional email suppression reason" });
    }
    return this.#upsertOnce({
      userId: input.userId,
      at: input.at,
      fields: {
        suppressedAt: { $ifNull: ["$suppressedAt", input.at] },
        suppressionReason: { $ifNull: ["$suppressionReason", input.reason] },
      },
    });
  }

  #assertInput(input: { userId: string; at: Date }): void {
    if (!ObjectId.isValid(input.userId) || Number.isNaN(input.at.getTime())) {
      throw new InternalServerError({ debugMessage: "Invalid optional email preference input" });
    }
  }

  async #upsertOnce(input: {
    userId: string;
    at: Date;
    fields: Record<string, unknown>;
  }): Promise<OptionalEmailPreference> {
    const userId = new ObjectId(input.userId);
    try {
      const preference = await this.#collection.findOneAndUpdate(
        { userId },
        [
          {
            $set: {
              ...input.fields,
              createdAt: { $ifNull: ["$createdAt", input.at] },
              updatedAt: input.at,
            },
          },
        ],
        { upsert: true, returnDocument: "after" },
      );
      if (preference) {
        return preference;
      }
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) {
        throw error;
      }
    }

    const winner = await this.#collection.findOne({ userId });
    if (!winner) {
      throw new InternalServerError({ debugMessage: "Failed to persist optional email preference" });
    }
    return winner;
  }
}

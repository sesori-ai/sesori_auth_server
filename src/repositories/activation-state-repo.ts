import { Collection, MongoServerError, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { ActivationState } from "../models/documents.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

export type ActivationMilestoneUpdate = {
  mobileSetupAt?: Date;
  bridgeSetupAt?: Date;
  firstSessionAt?: Date;
};

export class ActivationStateRepository {
  readonly #collection: Collection<ActivationState>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<ActivationState>(MongoDbDatabase.Auth, AuthDbCollection.ActivationStates);
  }

  async findByUserId(userId: string): Promise<ActivationState | null> {
    if (!ObjectId.isValid(userId)) {
      return null;
    }
    return this.#collection.findOne({ userId: new ObjectId(userId) });
  }

  async createIfAbsent(userId: string, at = new Date()): Promise<ActivationState> {
    if (!ObjectId.isValid(userId)) {
      throw new InternalServerError({ debugMessage: "Invalid activation state userId" });
    }
    const objectUserId = new ObjectId(userId);
    try {
      const state = await this.#collection.findOneAndUpdate(
        { userId: objectUserId },
        {
          $setOnInsert: {
            _id: new ObjectId(),
            userId: objectUserId,
            mobileSetupAt: null,
            bridgeSetupAt: null,
            firstSessionAt: null,
            bridgeReminderBaseAt: null,
            sessionReminderBaseAt: null,
            bridgeReminder1SentAt: null,
            bridgeReminder2SentAt: null,
            sessionReminderSentAt: null,
            backfilledAt: null,
            createdAt: at,
            updatedAt: at,
          },
        },
        { upsert: true, returnDocument: "after" },
      );

      if (!state) {
        throw new InternalServerError({ debugMessage: "Failed to create activation state" });
      }
      return state;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        const winner = await this.#collection.findOne({ userId: objectUserId });
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
  }

  async recordMilestones(userId: string, update: ActivationMilestoneUpdate, at = new Date()): Promise<ActivationState> {
    await this.createIfAbsent(userId, at);
    const objectUserId = new ObjectId(userId);
    const mobileCandidate = update.mobileSetupAt ?? null;
    const bridgeCandidate = update.bridgeSetupAt ?? null;
    const sessionCandidate = update.firstSessionAt ?? null;
    const state = await this.#collection.findOneAndUpdate(
      { userId: objectUserId },
      [
        {
          $set: {
            mobileSetupAt: { $ifNull: ["$mobileSetupAt", mobileCandidate] },
            bridgeSetupAt: { $ifNull: ["$bridgeSetupAt", bridgeCandidate] },
            firstSessionAt: { $ifNull: ["$firstSessionAt", sessionCandidate] },
            bridgeReminderBaseAt: {
              $ifNull: ["$bridgeReminderBaseAt", { $ifNull: ["$mobileSetupAt", mobileCandidate] }],
            },
            updatedAt: at,
          },
        },
        {
          $set: {
            sessionReminderBaseAt: {
              $ifNull: [
                "$sessionReminderBaseAt",
                {
                  $cond: [
                    {
                      $and: [{ $ne: ["$mobileSetupAt", null] }, { $ne: ["$bridgeSetupAt", null] }],
                    },
                    {
                      $cond: [{ $gte: ["$mobileSetupAt", "$bridgeSetupAt"] }, "$mobileSetupAt", "$bridgeSetupAt"],
                    },
                    null,
                  ],
                },
              ],
            },
          },
        },
      ],
      { returnDocument: "after" },
    );

    if (!state) {
      throw new InternalServerError({ debugMessage: "Failed to record activation milestones" });
    }
    return state;
  }
}

import { Collection, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { ActivationState } from "../models/documents.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

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
  }
}

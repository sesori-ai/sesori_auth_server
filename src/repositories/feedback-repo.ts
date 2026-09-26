import { Collection, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { Feedback } from "../models/documents.js";
import type { SubmitFeedbackBody } from "../models/feedback.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

export class FeedbackRepository {
  readonly #collection: Collection<Feedback>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<Feedback>(MongoDbDatabase.Auth, AuthDbCollection.Feedback);
  }

  async insert(userId: string, submission: SubmitFeedbackBody): Promise<void> {
    if (!ObjectId.isValid(userId)) {
      throw new InternalServerError({ debugMessage: "Invalid feedback userId" });
    }

    const { message, ...rest } = submission;
    await this.#collection.insertOne({
      _id: new ObjectId(),
      userId: new ObjectId(userId),
      ...rest,
      ...(message === undefined ? {} : { message }),
      createdAt: new Date(),
    });
  }

  // For account deletion, served by the userId index. Throws on a malformed
  // userId rather than returning quietly, so a purge that never ran cannot be
  // reported as done.
  async deleteAllForUser(userId: string): Promise<void> {
    if (!ObjectId.isValid(userId)) {
      throw new InternalServerError({ debugMessage: "Invalid feedback userId" });
    }

    await this.#collection.deleteMany({ userId: new ObjectId(userId) });
  }
}

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
}

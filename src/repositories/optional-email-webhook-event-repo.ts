import { Collection, MongoServerError, ObjectId } from "mongodb";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { OptionalEmailWebhookEvent } from "../models/documents.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

export class OptionalEmailWebhookEventRepository {
  readonly #collection: Collection<OptionalEmailWebhookEvent>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<OptionalEmailWebhookEvent>(
      MongoDbDatabase.Auth,
      AuthDbCollection.OptionalEmailWebhookEvents,
    );
  }

  async wasProcessed(input: { eventId: string }): Promise<boolean> {
    this.#validateEventId(input.eventId);
    return (await this.#collection.countDocuments({ eventId: input.eventId }, { limit: 1 })) > 0;
  }

  async recordProcessed(input: { eventId: string; eventType: string; processedAt: Date }): Promise<boolean> {
    this.#validateEventId(input.eventId);
    if (!input.eventType || input.eventType.length > 128 || Number.isNaN(input.processedAt.getTime())) {
      throw new InternalServerError({ debugMessage: "Invalid optional email webhook event" });
    }

    try {
      await this.#collection.insertOne({
        _id: new ObjectId(),
        eventId: input.eventId,
        eventType: input.eventType,
        processedAt: input.processedAt,
      });
      return true;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        return false;
      }
      throw error;
    }
  }

  #validateEventId(eventId: string): void {
    if (!eventId || eventId.length > 256) {
      throw new InternalServerError({ debugMessage: "Invalid optional email webhook event id" });
    }
  }
}

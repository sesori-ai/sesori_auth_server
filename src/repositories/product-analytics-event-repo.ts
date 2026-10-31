import { Collection, MongoServerError, ObjectId } from "mongodb";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { ProductAnalyticsEvent } from "../models/documents.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";
import { productAnalyticsUserKeySchema, type ProductAnalyticsEventBody } from "../types/product-analytics.js";

const DUPLICATE_KEY_ERROR_CODE = 11000;

export class ProductAnalyticsEventRepository {
  readonly #collection: Collection<ProductAnalyticsEvent>;

  constructor(deps: { accessor: MongoDbAccessor }) {
    this.#collection = deps.accessor.getCollection<ProductAnalyticsEvent>(
      MongoDbDatabase.Auth,
      AuthDbCollection.ProductAnalyticsEvents,
    );
  }

  async insert(input: { userKey: string; event: ProductAnalyticsEventBody; receivedAt: Date }): Promise<void> {
    try {
      await this.#collection.insertOne({
        _id: new ObjectId(),
        userKey: input.userKey,
        eventName: input.event.name,
        occurredAtMicros: input.event.occurredAtMicros,
        receivedAt: input.receivedAt,
        schemaVersion: input.event.schemaVersion,
        platform: input.event.platform,
        appVersion: input.event.appVersion,
        params: input.event.params,
      });
    } catch (error) {
      // A retry after the server committed resends the same natural key. The
      // event is already stored, so this is success rather than a failure to log.
      if (error instanceof MongoServerError && error.code === DUPLICATE_KEY_ERROR_CODE) {
        return;
      }
      throw error;
    }
  }

  async deleteForUserKey(input: { userKey: string }): Promise<void> {
    if (!productAnalyticsUserKeySchema.safeParse(input.userKey).success) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics event deletion key" });
    }
    await this.#collection.deleteMany({ userKey: input.userKey });
  }
}

import { Collection, MongoServerError, ObjectId } from "mongodb";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import { productAnalyticsEventSchema, type ProductAnalyticsEvent } from "../models/documents.js";
import type { ProductAnalyticsDesktopEvent } from "../models/product-analytics-export.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";
import {
  ProductAnalyticsEventName,
  productAnalyticsUserKeySchema,
  type ProductAnalyticsEventBody,
} from "../types/product-analytics.js";

const DUPLICATE_KEY_ERROR_CODE = 11000;
const knownEventNames: ReadonlySet<string> = new Set(Object.values(ProductAnalyticsEventName));

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

  /**
   * Yields events with `receivedAt` in `[start, end)`, served by the TTL index, in batches of `batchLimit`.
   * An event name this build doesn't know (stored by a newer server) is reported
   * through `onUnknownEventName` and skipped; any other malformed row fails the export.
   */
  async *findExportBatches(input: {
    start: Date;
    end: Date;
    batchLimit: number;
    onUnknownEventName: (eventName: string) => void;
  }): AsyncGenerator<ProductAnalyticsDesktopEvent[]> {
    const cursor = this.#collection
      .find({ receivedAt: { $gte: input.start, $lt: input.end } })
      .batchSize(input.batchLimit);
    let batch: ProductAnalyticsDesktopEvent[] = [];
    for await (const document of cursor) {
      const eventName: unknown = document.eventName;
      if (typeof eventName === "string" && !knownEventNames.has(eventName)) {
        input.onUnknownEventName(eventName);
        continue;
      }

      const parsed = productAnalyticsEventSchema.safeParse(document);
      if (!parsed.success) {
        // An issue's path can hold a stored params key, so the issues aren't logged.
        throw new InternalServerError({ debugMessage: "Malformed product analytics event" });
      }
      const { _id, ...event } = parsed.data;
      batch.push(event);
      if (batch.length === input.batchLimit) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) {
      yield batch;
    }
  }

  async deleteForUserKey(input: { userKey: string }): Promise<void> {
    if (!productAnalyticsUserKeySchema.safeParse(input.userKey).success) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics event deletion key" });
    }
    await this.#collection.deleteMany({ userKey: input.userKey });
  }
}

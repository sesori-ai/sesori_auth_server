import { Collection, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { MongoDbDatabase } from "../types/mongo.js";
import { InternalServerError } from "../lib/errors.js";

const METADATA_USAGE_COLLECTION = "metadataUsage";

interface MetadataUsageDoc {
  _id: ObjectId;
  userId: ObjectId;
  date: string;
  requestCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function todayUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Repository for per-day session metadata request counts, backed by MongoDB.
 *
 * Each document tracks a single (userId, date) pair and stores the cumulative
 * number of metadata requests made that day. Documents are upserted atomically
 * so concurrent requests never produce duplicate rows.
 */
export class MetadataUsageRepository {
  readonly #collection: Collection<MetadataUsageDoc>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<MetadataUsageDoc>(MongoDbDatabase.Auth, METADATA_USAGE_COLLECTION);
  }

  /**
   * Atomically increments today's metadata request count for a user (upsert).
   *
   * Returns the count BEFORE the increment (`previousCount`) and AFTER (`newCount`).
   * Using returnDocument "before" lets callers detect concurrent quota races: if
   * `previousCount >= limit`, another request already exhausted the quota between
   * the caller's pre-check and this increment.
   *
   * @throws InternalServerError when the MongoDB driver returns an unexpected falsy result.
   */
  async incrementCount(userId: string): Promise<{ previousCount: number; newCount: number }> {
    const now = new Date();
    const dateKey = todayUtcDateKey();

    const result = await this.#collection.findOneAndUpdate(
      { userId: new ObjectId(userId), date: dateKey },
      {
        $inc: { requestCount: 1 },
        $setOnInsert: {
          _id: new ObjectId(),
          userId: new ObjectId(userId),
          date: dateKey,
          createdAt: now,
        },
        $set: { updatedAt: now },
      },
      { upsert: true, returnDocument: "before" },
    );

    if (result === null) {
      // Upsert created a new document — no previous usage exists.
      return { previousCount: 0, newCount: 1 };
    }

    if (!result) {
      throw new InternalServerError({ debugMessage: "Failed to upsert metadata usage document" });
    }

    const previousCount = result.requestCount;
    return { previousCount, newCount: previousCount + 1 };
  }
}

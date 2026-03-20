import { Collection, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import type { DailyUsage } from "../models/documents.js";
import { InternalServerError } from "../lib/errors.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

/** Returns today's UTC date as YYYY-MM-DD for use as a daily aggregation key. */
export function todayUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export class DailyUsageRepository {
  readonly #collection: Collection<DailyUsage>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<DailyUsage>(MongoDbDatabase.Auth, AuthDbCollection.DailyUsage);
  }

  /** Gets today's accumulated transcription seconds for a user. Returns 0 if no usage document exists yet. */
  async getDailyTranscriptionSeconds(userId: string): Promise<number> {
    const doc = await this.#collection.findOne({ userId: new ObjectId(userId), date: todayUtcDateKey() });
    return doc?.transcriptionSeconds ?? 0;
  }

  /**
   * Atomically increments today's transcription seconds for a user (upsert).
   * Returns the total BEFORE the increment (`previousTotal`) and AFTER (`newTotal`).
   * Using returnDocument "before" allows callers to detect concurrent quota races:
   * if `previousTotal >= limit`, another request already consumed quota between
   * the caller's pre-check and this increment.
   */
  async incrementTranscriptionSeconds(
    userId: string,
    seconds: number,
  ): Promise<{ previousTotal: number; newTotal: number }> {
    const now = new Date();
    const result = await this.#collection.findOneAndUpdate(
      { userId: new ObjectId(userId), date: todayUtcDateKey() },
      {
        $inc: { transcriptionSeconds: seconds },
        $setOnInsert: { _id: new ObjectId(), userId: new ObjectId(userId), date: todayUtcDateKey(), createdAt: now },
        $set: { updatedAt: now },
      },
      { upsert: true, returnDocument: "before" },
    );

    if (result === null) {
      // Upsert created a new document — no previous usage.
      return { previousTotal: 0, newTotal: seconds };
    }

    if (!result) {
      throw new InternalServerError({ debugMessage: "Failed to upsert daily usage document" });
    }

    const previousTotal = result.transcriptionSeconds;
    return { previousTotal, newTotal: previousTotal + seconds };
  }
}

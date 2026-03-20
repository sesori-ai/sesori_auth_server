import { ObjectId } from "mongodb";
import { DatabaseAccessor } from "../db/database-accessor.js";

export function todayUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export class DailyUsageRepository {
  private constructor() {}

  static async getDailyTranscriptionSeconds(userId: ObjectId): Promise<number> {
    const doc = await DatabaseAccessor.dailyUsage().findOne({
      userId,
      date: todayUtcDateKey(),
    });
    return doc?.transcriptionSeconds ?? 0;
  }

  static async incrementTranscriptionSeconds(userId: ObjectId, seconds: number): Promise<number> {
    const now = new Date();
    const result = await DatabaseAccessor.dailyUsage().findOneAndUpdate(
      { userId, date: todayUtcDateKey() },
      {
        $inc: { transcriptionSeconds: seconds },
        $setOnInsert: { _id: new ObjectId(), userId, createdAt: now },
        $set: { updatedAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (!result) {
      throw new Error("Failed to upsert daily usage document");
    }
    return result.transcriptionSeconds;
  }
}

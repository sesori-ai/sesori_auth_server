import { ObjectId } from "mongodb";
import { DatabaseAccessor } from "../db/database-accessor.js";

function todayUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export class TranscriptionUsageRepository {
  private constructor() {}

  static async getDailyUsedSeconds(userId: ObjectId): Promise<number> {
    const doc = await DatabaseAccessor.transcriptionUsage().findOne({
      userId,
      date: todayUtcDateKey(),
    });
    return doc?.usedSeconds ?? 0;
  }

  static async incrementDailyUsage(userId: ObjectId, seconds: number): Promise<number> {
    const now = new Date();
    const result = await DatabaseAccessor.transcriptionUsage().findOneAndUpdate(
      { userId, date: todayUtcDateKey() },
      {
        $inc: { usedSeconds: seconds },
        $setOnInsert: { _id: new ObjectId(), userId, createdAt: now },
        $set: { updatedAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    return result!.usedSeconds;
  }
}

import { ObjectId } from "mongodb";
import { DatabaseAccessor } from "../db/database-accessor.js";
import type { GlossaryEntry } from "../models/documents.js";

export class GlossaryEntryRepository {
  private constructor() {}

  static async findByUserId(userId: ObjectId): Promise<GlossaryEntry[]> {
    return DatabaseAccessor.glossaryEntries().find({ userId }).sort({ word: 1 }).toArray();
  }

  static async insertMany(args: { userId: ObjectId; words: string[] }): Promise<string[]> {
    const { userId, words } = args;
    if (words.length === 0) return [];

    const now = new Date();
    const docs: GlossaryEntry[] = words.map((word) => ({
      _id: new ObjectId(),
      userId,
      word,
      createdAt: now,
    }));

    try {
      const result = await DatabaseAccessor.glossaryEntries().insertMany(docs, { ordered: false });
      const insertedIds = new Set(Object.values(result.insertedIds).map((id) => id.toHexString()));
      return docs.filter((d) => insertedIds.has(d._id.toHexString())).map((d) => d.word);
    } catch (error: unknown) {
      // ordered:false + duplicate key (11000) → throws but non-duplicate inserts still succeed.
      if (isBulkWriteError(error)) {
        const insertedCount = error.result?.insertedCount ?? 0;
        if (insertedCount > 0) {
          const failedIndices = new Set(error.writeErrors?.map((e: { index: number }) => e.index) ?? []);
          return docs.filter((_, i) => !failedIndices.has(i)).map((d) => d.word);
        }
        return [];
      }
      throw error;
    }
  }

  static async deleteMany(args: { userId: ObjectId; words: string[] }): Promise<number> {
    const { userId, words } = args;
    if (words.length === 0) return 0;

    const result = await DatabaseAccessor.glossaryEntries().deleteMany({
      userId,
      word: { $in: words },
    });
    return result.deletedCount;
  }
}

function isBulkWriteError(error: unknown): error is {
  code: number;
  result?: { insertedCount: number };
  writeErrors?: Array<{ index: number }>;
} {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === 11000
  );
}

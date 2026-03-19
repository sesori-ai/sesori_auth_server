import { Collection, MongoBulkWriteError, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import type { GlossaryEntry } from "../models/documents.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

export class GlossaryEntryRepository {
  readonly #collection: Collection<GlossaryEntry>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<GlossaryEntry>(MongoDbDatabase.Auth, AuthDbCollection.GlossaryEntries);
  }

  async findByUserId(userId: string): Promise<GlossaryEntry[]> {
    return this.#collection
      .find({ userId: new ObjectId(userId) })
      .sort({ word: 1 })
      .toArray();
  }

  async countByUserId(userId: string): Promise<number> {
    return this.#collection.countDocuments({ userId: new ObjectId(userId) });
  }

  async insertMany(args: { userId: string; words: string[] }): Promise<string[]> {
    const { userId, words } = args;
    if (words.length === 0) return [];
    const objectUserId = new ObjectId(userId);

    const now = new Date();
    const docs: GlossaryEntry[] = words.map((word) => ({
      _id: new ObjectId(),
      userId: objectUserId,
      word,
      createdAt: now,
    }));

    try {
      const result = await this.#collection.insertMany(docs, { ordered: false });
      const insertedIds = new Set(Object.values(result.insertedIds).map((id) => id.toHexString()));
      return docs.filter((d) => insertedIds.has(d._id.toHexString())).map((d) => d.word);
    } catch (error: unknown) {
      // ordered:false + duplicate key (11000) → throws but non-duplicate inserts still succeed.
      if (error instanceof MongoBulkWriteError && error.code === 11000) {
        const insertedCount = error.result?.insertedCount ?? 0;
        if (insertedCount > 0) {
          const errors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
          const failedIndices = new Set(errors.map((e) => e.index));
          return docs.filter((_, i) => !failedIndices.has(i)).map((d) => d.word);
        }
        return [];
      }
      throw error;
    }
  }

  async deleteMany(args: { userId: string; words: string[] }): Promise<number> {
    const { userId, words } = args;
    if (words.length === 0) return 0;

    const result = await this.#collection.deleteMany({
      userId: new ObjectId(userId),
      word: { $in: words },
    });
    return result.deletedCount;
  }
}

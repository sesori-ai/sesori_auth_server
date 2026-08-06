import { Collection, MongoBulkWriteError, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { glossaryEntrySchema, type GlossaryEntry } from "../models/documents.js";
import type { ProjectKey } from "../models/voice.js";
import { InternalServerError } from "../lib/errors.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

export class GlossaryEntryRepository {
  readonly #collection: Collection<GlossaryEntry>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<GlossaryEntry>(MongoDbDatabase.Auth, AuthDbCollection.GlossaryEntries);
  }

  async findByUserAndProject(args: { userId: string; projectKey: ProjectKey }): Promise<GlossaryEntry[]> {
    const entries = await this.#collection
      .find({ userId: new ObjectId(args.userId), projectKey: args.projectKey })
      .sort({ word: 1 })
      .toArray();

    return entries.map((entry) => this.#parseEntry(entry));
  }

  async countByUserAndProject(args: { userId: string; projectKey: ProjectKey }): Promise<number> {
    return this.#collection.countDocuments({ userId: new ObjectId(args.userId), projectKey: args.projectKey });
  }

  async countByUserId(userId: string): Promise<number> {
    return this.#collection.countDocuments({ userId: new ObjectId(userId) });
  }

  async insertMany(args: { userId: string; projectKey: ProjectKey; words: string[] }): Promise<string[]> {
    const { userId, projectKey, words } = args;
    if (words.length === 0) {
      return [];
    }

    const objectUserId = new ObjectId(userId);
    const now = new Date();
    const docs: GlossaryEntry[] = words.map((word) => ({
      _id: new ObjectId(),
      userId: objectUserId,
      projectKey,
      word,
      createdAt: now,
    }));

    try {
      const result = await this.#collection.insertMany(docs, { ordered: false });
      const insertedIds = new Set(Object.values(result.insertedIds).map((id) => id.toHexString()));
      return docs.filter((document) => insertedIds.has(document._id.toHexString())).map((document) => document.word);
    } catch (error: unknown) {
      if (error instanceof MongoBulkWriteError && error.code === 11000) {
        const errors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
        const failedIndices = new Set(errors.map((entry) => entry.index));
        return docs.filter((_, index) => !failedIndices.has(index)).map((document) => document.word);
      }
      throw error;
    }
  }

  async deleteMany(args: { userId: string; projectKey: ProjectKey; words: string[] }): Promise<number> {
    const { userId, projectKey, words } = args;
    if (words.length === 0) {
      return 0;
    }

    const result = await this.#collection.deleteMany({
      userId: new ObjectId(userId),
      projectKey,
      word: { $in: words },
    });
    return result.deletedCount;
  }

  #parseEntry(entry: unknown): GlossaryEntry {
    const result = glossaryEntrySchema.safeParse(entry);
    if (!result.success) {
      throw new InternalServerError({ debugMessage: "Invalid glossary entry persistence" });
    }

    return result.data;
  }
}

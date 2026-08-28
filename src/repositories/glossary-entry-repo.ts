import { Collection, MongoBulkWriteError, ObjectId } from "mongodb";
import { z } from "zod";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { glossaryEntrySchema, type GlossaryEntry } from "../models/documents.js";
import { ProjectGlossaryScopeType, type ProjectGlossaryScope, type ProjectKey } from "../models/voice.js";
import { InternalServerError } from "../lib/errors.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

const countSchema = z.number().int().nonnegative().safe();

type ProjectGlossaryScopeFilter = {
  "scope.type": ProjectGlossaryScopeType;
  "scope.projectKey": ProjectKey;
  "scope.bridgeId"?: string;
};

function scopeFilter(scope: ProjectGlossaryScope): ProjectGlossaryScopeFilter {
  const base = {
    "scope.type": scope.type,
    "scope.projectKey": scope.projectKey,
  };
  return scope.type === ProjectGlossaryScopeType.bridgeLocal ? { ...base, "scope.bridgeId": scope.bridgeId } : base;
}

export class GlossaryEntryRepository {
  readonly #collection: Collection<GlossaryEntry>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<GlossaryEntry>(MongoDbDatabase.Auth, AuthDbCollection.GlossaryEntries);
  }

  /** Returns the project's words. Documents stay inside the repository boundary. */
  async findWordsByUserAndProject(args: { userId: string; projectKey: ProjectKey }): Promise<string[]> {
    const entries = await this.#collection
      .find({ userId: new ObjectId(args.userId), "scope.projectKey": args.projectKey })
      .sort({ word: 1 })
      .toArray();

    return [...new Set(entries.map((entry) => this.#parseEntry(entry).word))];
  }

  async findWordsByUserAndScope(args: { userId: string; scope: ProjectGlossaryScope }): Promise<string[]> {
    const entries = await this.#collection
      .find({ userId: new ObjectId(args.userId), ...scopeFilter(args.scope) })
      .sort({ word: 1 })
      .toArray();

    return entries.map((entry) => this.#parseEntry(entry).word);
  }

  async countByUserAndProject(args: { userId: string; projectKey: ProjectKey }): Promise<number> {
    return this.#parseCount(
      await this.#collection.countDocuments({
        userId: new ObjectId(args.userId),
        "scope.projectKey": args.projectKey,
      }),
    );
  }

  async countScopedByUserId(userId: string): Promise<number> {
    return this.#parseCount(await this.#collection.countDocuments({ userId: new ObjectId(userId) }));
  }

  async insertMany(args: { userId: string; scope: ProjectGlossaryScope; words: string[] }): Promise<string[]> {
    const { userId, scope, words } = args;
    if (words.length === 0) {
      return [];
    }

    const objectUserId = new ObjectId(userId);
    const now = new Date();
    const docs: GlossaryEntry[] = words.map((word) => ({
      _id: new ObjectId(),
      userId: objectUserId,
      scope,
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

  async deleteByUserAndBridge(args: { userId: string; bridgeId: string }): Promise<number> {
    const result = await this.#collection.deleteMany({
      userId: new ObjectId(args.userId),
      "scope.type": ProjectGlossaryScopeType.bridgeLocal,
      "scope.bridgeId": args.bridgeId,
    });
    return this.#parseCount(result.deletedCount);
  }

  async deleteAllBridgeLocalByUser(args: { userId: string }): Promise<number> {
    const result = await this.#collection.deleteMany({
      userId: new ObjectId(args.userId),
      "scope.type": ProjectGlossaryScopeType.bridgeLocal,
    });
    return this.#parseCount(result.deletedCount);
  }

  async deleteMany(args: { userId: string; scope: ProjectGlossaryScope; words: string[] }): Promise<number> {
    const { userId, scope, words } = args;
    if (words.length === 0) {
      return 0;
    }

    const result = await this.#collection.deleteMany({
      userId: new ObjectId(userId),
      ...scopeFilter(scope),
      word: { $in: words },
    });
    return this.#parseCount(result.deletedCount);
  }

  #parseCount(value: unknown): number {
    const result = countSchema.safeParse(value);
    if (!result.success) {
      throw new InternalServerError({ debugMessage: "Invalid glossary count result" });
    }

    return result.data;
  }

  #parseEntry(entry: unknown): GlossaryEntry {
    const result = glossaryEntrySchema.safeParse(entry);
    if (!result.success) {
      throw new InternalServerError({ debugMessage: "Invalid glossary entry persistence" });
    }

    return result.data;
  }
}

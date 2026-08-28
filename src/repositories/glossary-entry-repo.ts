import { Collection, MongoServerError, ObjectId, type Document } from "mongodb";
import { z } from "zod";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { glossaryEntrySchema, type GlossaryEntry } from "../models/documents.js";
import { ProjectGlossaryScopeType, type ProjectGlossaryScope, type ProjectKey } from "../models/voice.js";
import { InternalServerError } from "../lib/errors.js";
import { bridgeIdSchema } from "../models/bridge.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

const countSchema = z.number().int().nonnegative().safe();
const bridgeIdsSchema = z.array(bridgeIdSchema);
const MAX_SCOPE_UPSERT_ATTEMPTS = 5;

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

function sortWords(words: Iterable<string>): string[] {
  return [...words].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export class GlossaryEntryRepository {
  readonly #collection: Collection<GlossaryEntry>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<GlossaryEntry>(MongoDbDatabase.Auth, AuthDbCollection.GlossaryEntries);
  }

  /** Returns the project's deduplicated words. Documents stay inside the repository boundary. */
  async findWordsByUserAndProject(args: { userId: string; projectKey: ProjectKey }): Promise<string[]> {
    const entries = await this.#collection
      .find({ userId: new ObjectId(args.userId), "scope.projectKey": args.projectKey })
      .toArray();
    const words = new Set<string>();
    for (const entry of entries) {
      for (const word of this.#parseEntry(entry).words) {
        words.add(word);
      }
    }
    return sortWords(words);
  }

  async findWordsByUserAndScope(args: { userId: string; scope: ProjectGlossaryScope }): Promise<string[]> {
    const entry = await this.#collection.findOne({
      userId: new ObjectId(args.userId),
      ...scopeFilter(args.scope),
    });
    return entry ? sortWords(new Set(this.#parseEntry(entry).words)) : [];
  }

  async countByUserAndProject(args: { userId: string; projectKey: ProjectKey }): Promise<number> {
    return this.#countWords({
      userId: new ObjectId(args.userId),
      "scope.projectKey": args.projectKey,
    });
  }

  async countScopedByUserId(userId: string): Promise<number> {
    return this.#countWords({ userId: new ObjectId(userId) });
  }

  async addWords(args: { userId: string; scope: ProjectGlossaryScope; words: string[] }): Promise<string[]> {
    const requested = [...new Set(args.words)];
    if (requested.length === 0) {
      return [];
    }

    return this.#addWordsToScopeWithRetry({
      objectUserId: new ObjectId(args.userId),
      scope: args.scope,
      words: requested,
      now: new Date(),
      attemptsRemaining: MAX_SCOPE_UPSERT_ATTEMPTS,
    });
  }

  async findBridgeLocalOwnerIdsByUser(args: { userId: string }): Promise<string[]> {
    const values = await this.#collection.distinct("scope.bridgeId", {
      userId: new ObjectId(args.userId),
      "scope.type": ProjectGlossaryScopeType.bridgeLocal,
    });
    const parsed = bridgeIdsSchema.safeParse(values);
    if (!parsed.success) {
      throw new InternalServerError({ debugMessage: "Invalid bridge-local glossary ownership persistence" });
    }
    return parsed.data;
  }

  async deleteByUserAndBridge(args: { userId: string; bridgeId: string }): Promise<number> {
    return this.deleteByUserAndBridges({ userId: args.userId, bridgeIds: [args.bridgeId] });
  }

  async deleteByUserAndBridges(args: { userId: string; bridgeIds: string[] }): Promise<number> {
    if (args.bridgeIds.length === 0) {
      return 0;
    }

    const result = await this.#collection.deleteMany({
      userId: new ObjectId(args.userId),
      "scope.type": ProjectGlossaryScopeType.bridgeLocal,
      "scope.bridgeId": { $in: args.bridgeIds },
    });
    return this.#parseCount(result.deletedCount);
  }

  async removeWords(args: { userId: string; scope: ProjectGlossaryScope; words: string[] }): Promise<number> {
    const requested = [...new Set(args.words)];
    if (requested.length === 0) {
      return 0;
    }

    const exactScopeFilter = {
      userId: new ObjectId(args.userId),
      ...scopeFilter(args.scope),
    };
    const before = await this.#collection.findOneAndUpdate(
      {
        ...exactScopeFilter,
        words: { $in: requested },
      },
      {
        $pull: { words: { $in: requested } },
        $set: { updatedAt: new Date() },
      },
      { returnDocument: "before" },
    );
    if (!before) {
      // A previous removal can have committed its $pull but failed before
      // deleting the empty document. A retry must complete that cleanup.
      await this.#collection.deleteOne({ ...exactScopeFilter, words: { $size: 0 } });
      return 0;
    }

    const entry = this.#parseEntry(before);
    const previousWords = new Set(entry.words);
    const removed = requested.filter((word) => previousWords.has(word)).length;
    await this.#collection.deleteOne({ _id: entry._id, words: { $size: 0 } });
    return removed;
  }

  async #addWordsToScopeWithRetry(args: {
    objectUserId: ObjectId;
    scope: ProjectGlossaryScope;
    words: string[];
    now: Date;
    attemptsRemaining: number;
  }): Promise<string[]> {
    try {
      return await this.#addWordsToScope(args);
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000 && args.attemptsRemaining > 1) {
        // A first-write upsert can lose the exact-scope unique-index race. The
        // winner can also remove the last word before this caller retries, so
        // allow several races to settle without retrying a persistent conflict
        // forever.
        return this.#addWordsToScopeWithRetry({
          ...args,
          attemptsRemaining: args.attemptsRemaining - 1,
        });
      }
      throw error;
    }
  }

  async #addWordsToScope(args: {
    objectUserId: ObjectId;
    scope: ProjectGlossaryScope;
    words: string[];
    now: Date;
  }): Promise<string[]> {
    const before = await this.#collection.findOneAndUpdate(
      {
        userId: args.objectUserId,
        ...scopeFilter(args.scope),
      },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          userId: args.objectUserId,
          scope: args.scope,
          createdAt: args.now,
        },
        $set: { updatedAt: args.now },
        $addToSet: { words: { $each: args.words } },
      },
      { upsert: true, returnDocument: "before" },
    );
    if (!before) {
      return args.words;
    }

    const existing = new Set(this.#parseEntry(before).words);
    return args.words.filter((word) => !existing.has(word));
  }

  async #countWords(filter: Document): Promise<number> {
    const result = await this.#collection
      .aggregate<{
        count: unknown;
      }>([
        { $match: filter },
        { $project: { _id: 0, count: { $size: "$words" } } },
        { $group: { _id: null, count: { $sum: "$count" } } },
      ])
      .next();
    return this.#parseCount(result?.count ?? 0);
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
      throw new InternalServerError({ debugMessage: "Invalid glossary scope persistence" });
    }

    return result.data;
  }
}

import { Collection, Db, MongoServerError, type Document, type IndexSpecification, type CreateIndexesOptions } from "mongodb";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";
import { MongoDbConnector } from "./mongo-db-connector.js";

export type IndexDefinition = {
  spec: IndexSpecification;
  options?: CreateIndexesOptions;
};

type DatabaseConfig<C extends string> = {
  collections: Record<C, IndexDefinition[]>;
};

const DATABASE_CONFIG: Record<MongoDbDatabase, DatabaseConfig<string>> = {
  [MongoDbDatabase.Auth]: {
    collections: {
      [AuthDbCollection.Users]: [],
      [AuthDbCollection.OAuthAccounts]: [
        { spec: { provider: 1, providerUserId: 1 }, options: { unique: true } },
        { spec: { userId: 1 } },
      ],
      [AuthDbCollection.PasswordAccounts]: [
        { spec: { email: 1 }, options: { unique: true } },
        { spec: { userId: 1 }, options: { unique: true } },
      ],
      [AuthDbCollection.GlossaryEntries]: [{ spec: { userId: 1, word: 1 }, options: { unique: true } }],
      [AuthDbCollection.DailyUsage]: [{ spec: { userId: 1, date: 1 }, options: { unique: true } }],
      [AuthDbCollection.DeviceTokens]: [{ spec: { token: 1 }, options: { unique: true } }, { spec: { userId: 1 } }],
    },
  } satisfies DatabaseConfig<AuthDbCollection>,
};

export function indexKeyMatches(a: IndexSpecification, b: IndexSpecification): boolean {
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const keysA = Object.keys(aRec);
  const keysB = Object.keys(bRec);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k, i) => k === keysB[i] && aRec[k] === bRec[k]);
}

export function indexMatchesDesired(existing: Record<string, unknown>, desired: IndexDefinition): boolean {
  if (!indexKeyMatches(existing.key as IndexSpecification, desired.spec)) return false;
  const desiredUnique = desired.options?.unique ?? false;
  const existingUnique = existing.unique === true;
  return desiredUnique === existingUnique;
}

export class MongoDbAccessor {
  readonly #connector: MongoDbConnector;

  constructor(connector: MongoDbConnector) {
    this.#connector = connector;
  }

  getDb(name: MongoDbDatabase): Db {
    return this.#connector.getDb(name);
  }

  getCollection<T extends Document>(database: MongoDbDatabase, collection: string): Collection<T> {
    return this.getDb(database).collection(collection);
  }

  async ensureIndexes(): Promise<void> {
    for (const dbName of Object.values(MongoDbDatabase)) {
      const dbConfig = DATABASE_CONFIG[dbName];
      const db = this.getDb(dbName);

      const existingCollections = new Set((await db.listCollections().toArray()).map((c) => c.name));

      for (const [collectionName, indexes] of Object.entries(dbConfig.collections)) {
        if (!existingCollections.has(collectionName)) {
          await db.createCollection(collectionName);
        }

        const collection = db.collection(collectionName);
        const existingIndexes = await collection.indexes();

        for (const desired of indexes) {
          const alreadyExists = existingIndexes.some((idx) => indexMatchesDesired(idx, desired));
          if (alreadyExists) continue;

          try {
            await collection.createIndex(desired.spec, desired.options ?? {});
          } catch (error) {
            if (error instanceof MongoServerError && error.code === 86) {
              const specKeys = Object.keys(desired.spec).join(",");
              console.warn(
                `Index conflict on ${collectionName} (${specKeys}): existing index differs from desired config. Manual cleanup may be required.`
              );
              continue;
            }
            throw error;
          }
        }
      }
    }
  }
}

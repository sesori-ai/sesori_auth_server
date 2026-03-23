import { Collection, Db, type Document, type IndexSpecification, type CreateIndexesOptions } from "mongodb";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";
import { MongoDbConnector } from "./mongo-db-connector.js";

type IndexDefinition = {
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
      [AuthDbCollection.GlossaryEntries]: [{ spec: { userId: 1, word: 1 }, options: { unique: true } }],
      [AuthDbCollection.DailyUsage]: [{ spec: { userId: 1, date: 1 }, options: { unique: true } }],
    },
  } satisfies DatabaseConfig<AuthDbCollection>,
};

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

      const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

      for (const [collectionName, indexes] of Object.entries(dbConfig.collections)) {
        if (!existing.has(collectionName)) {
          await db.createCollection(collectionName);
        }

        const collection = db.collection(collectionName);
        for (const index of indexes) {
          await collection.createIndex(index.spec, index.options ?? {});
        }
      }
    }
  }
}

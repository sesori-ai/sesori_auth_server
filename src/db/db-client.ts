import { Collection, Db } from "mongodb";
import { getMongoDbConnector, MongoDBDatabase } from "./mongo-db-connector.js";
import { User, OAuthAccount, GlossaryEntry, TranscriptionUsage } from "../models/documents.js";

export { MongoDBDatabase } from "./mongo-db-connector.js";
export { closeMongoDbConnector as closeDb } from "./mongo-db-connector.js";

export enum OAuthAccountCollection {
  Users = "users",
  OAuthAccounts = "oauthAccounts",
  GlossaryEntries = "glossaryEntries",
  TranscriptionUsage = "transcriptionUsage",
}

type DatabaseCollectionMap = {
  [MongoDBDatabase.OAuth]: OAuthAccountCollection;
};

type CollectionFor<D extends MongoDBDatabase> = DatabaseCollectionMap[D];

type CollectionDocumentMap = {
  [OAuthAccountCollection.Users]: User;
  [OAuthAccountCollection.OAuthAccounts]: OAuthAccount;
  [OAuthAccountCollection.GlossaryEntries]: GlossaryEntry;
  [OAuthAccountCollection.TranscriptionUsage]: TranscriptionUsage;
};

class DbClient<D extends MongoDBDatabase> {
  private readonly db: D;

  constructor(db: D) {
    this.db = db;
  }

  getDatabase(): Db {
    return getMongoDbConnector().getDb(this.db);
  }

  getCollection<N extends CollectionFor<D> & keyof CollectionDocumentMap>(
    name: N,
  ): Collection<CollectionDocumentMap[N]> {
    const db = this.getDatabase();
    return db.collection(name);
  }
}

export const oAuthDbClient = new DbClient(MongoDBDatabase.OAuth);

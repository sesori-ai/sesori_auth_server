import { MongoClient, Db } from "mongodb";

export enum DatabaseName {
  OAuth = "oauth",
}

let sharedClient: MongoClient | null = null;

class DbClient {
  private readonly dbName: DatabaseName;

  constructor(dbName: DatabaseName) {
    this.dbName = dbName;
  }

  async connect(uri: string): Promise<MongoClient> {
    if (sharedClient) {
      return sharedClient;
    }

    sharedClient = new MongoClient(uri);
    await sharedClient.connect();

    return sharedClient;
  }

  getDb(): Db {
    if (!sharedClient) {
      throw new Error("Database not connected. Call connect() first.");
    }
    return sharedClient.db(this.dbName);
  }

  async close(): Promise<void> {
    if (sharedClient) {
      await sharedClient.close();
      sharedClient = null;
    }
  }
}

export const dbClient = new DbClient(DatabaseName.OAuth);

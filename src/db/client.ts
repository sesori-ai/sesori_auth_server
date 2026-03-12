import { MongoClient, Db } from "mongodb";

export enum DatabaseName {
  OAuth = "oauth",
}

export class DbClient {
  private static client: MongoClient | null = null;

  private constructor() {}

  static async connect(uri: string): Promise<MongoClient> {
    if (DbClient.client) {
      return DbClient.client;
    }

    DbClient.client = new MongoClient(uri);
    await DbClient.client.connect();

    return DbClient.client;
  }

  static getDb(name: DatabaseName): Db {
    if (!DbClient.client) {
      throw new Error("Database not connected. Call connect() first.");
    }
    return DbClient.client.db(name);
  }

  static async close(): Promise<void> {
    if (DbClient.client) {
      await DbClient.client.close();
      DbClient.client = null;
    }
  }
}

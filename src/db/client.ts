import { MongoClient, Db } from "mongodb";

export class DbClient {
  private static client: MongoClient | null = null;
  private static db: Db | null = null;

  private constructor() {}

  static async connect(uri: string): Promise<MongoClient> {
    if (DbClient.client) {
      return DbClient.client;
    }

    DbClient.client = new MongoClient(uri);
    await DbClient.client.connect();
    DbClient.db = DbClient.client.db("oauth");

    return DbClient.client;
  }

  static getDb(): Db {
    if (!DbClient.db) {
      throw new Error("Database not connected. Call connectDb() first.");
    }
    return DbClient.db;
  }

  static async close(): Promise<void> {
    if (DbClient.client) {
      await DbClient.client.close();
      DbClient.client = null;
      DbClient.db = null;
    }
  }
}

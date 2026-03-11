import { Collection } from "mongodb";
import { DbClient } from "./client.js";
import { User, OAuthAccount } from "../models/documents.js";

export class DatabaseAccessor {
  private constructor() {}

  static users(): Collection<User> {
    return DbClient.getDb().collection<User>("users");
  }

  static oauthAccounts(): Collection<OAuthAccount> {
    return DbClient.getDb().collection<OAuthAccount>("oauthAccounts");
  }

  static async ensureIndexes(): Promise<void> {
    const oauthAccountsCollection = DatabaseAccessor.oauthAccounts();
    await oauthAccountsCollection.createIndex(
      { provider: 1, providerUserId: 1 },
      { unique: true }
    );
    await oauthAccountsCollection.createIndex({ userId: 1 });
  }
}

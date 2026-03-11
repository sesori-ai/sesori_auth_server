import { Collection } from "mongodb";
import { DbClient } from "./client.js";
import { User, OAuthAccount, BridgeRegistration } from "../models/documents.js";

export class Collections {
  private constructor() {}

  static users(): Collection<User> {
    return DbClient.getDb().collection<User>("users");
  }

  static oauthAccounts(): Collection<OAuthAccount> {
    return DbClient.getDb().collection<OAuthAccount>("oauthAccounts");
  }

  static bridgeRegistrations(): Collection<BridgeRegistration> {
    return DbClient.getDb().collection<BridgeRegistration>("bridgeRegistrations");
  }

  static async ensureIndexes(): Promise<void> {
    const oauthAccountsCollection = Collections.oauthAccounts();
    await oauthAccountsCollection.createIndex(
      { provider: 1, providerUserId: 1 },
      { unique: true }
    );
    await oauthAccountsCollection.createIndex({ userId: 1 });

    const bridgeRegistrationsCollection = Collections.bridgeRegistrations();
    await bridgeRegistrationsCollection.createIndex(
      { userId: 1 },
      { unique: true }
    );
  }
}

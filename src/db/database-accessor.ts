import { Collection } from "mongodb";
import { oAuthDbClient, OAuthAccountCollection } from "./db-client.js";
import { User, OAuthAccount, GlossaryEntry } from "../models/documents.js";

export class DatabaseAccessor {
  private constructor() {}

  static users(): Collection<User> {
    return oAuthDbClient.getCollection(OAuthAccountCollection.Users);
  }

  static oauthAccounts(): Collection<OAuthAccount> {
    return oAuthDbClient.getCollection(OAuthAccountCollection.OAuthAccounts);
  }

  static glossaryEntries(): Collection<GlossaryEntry> {
    return oAuthDbClient.getCollection(OAuthAccountCollection.GlossaryEntries);
  }

  static async ensureIndexes(): Promise<void> {
    const oauthAccountsCollection = DatabaseAccessor.oauthAccounts();
    await oauthAccountsCollection.createIndex({ provider: 1, providerUserId: 1 }, { unique: true });
    await oauthAccountsCollection.createIndex({ userId: 1 });

    const glossaryEntriesCollection = DatabaseAccessor.glossaryEntries();
    await glossaryEntriesCollection.createIndex({ userId: 1, word: 1 }, { unique: true });
    await glossaryEntriesCollection.createIndex({ userId: 1 });
  }
}

import { Collection } from "mongodb";
import { getDb } from "./client.js";
import { User, OAuthAccount, BridgeRegistration } from "../models/documents.js";

export function users(): Collection<User> {
  return getDb().collection<User>("users");
}

export function oauthAccounts(): Collection<OAuthAccount> {
  return getDb().collection<OAuthAccount>("oauthAccounts");
}

export function bridgeRegistrations(): Collection<BridgeRegistration> {
  return getDb().collection<BridgeRegistration>("bridgeRegistrations");
}

export async function ensureIndexes(): Promise<void> {
  // Create indexes for oauthAccounts collection
  const oauthAccountsCollection = oauthAccounts();
  
  // Unique compound index on (provider, providerUserId)
  await oauthAccountsCollection.createIndex(
    { provider: 1, providerUserId: 1 },
    { unique: true }
  );
  
  // Index on userId for lookups
  await oauthAccountsCollection.createIndex({ userId: 1 });
  
  // Create unique index for bridgeRegistrations collection
  const bridgeRegistrationsCollection = bridgeRegistrations();
  
  // Unique index on userId (one bridge per user)
  await bridgeRegistrationsCollection.createIndex(
    { userId: 1 },
    { unique: true }
  );
}

import { ObjectId } from "mongodb";
import { oauthAccounts } from "../db/collections.js";
import type { OAuthAccount } from "../models/documents.js";

export async function findByProvider(
  provider: string,
  providerUserId: string
): Promise<OAuthAccount | null> {
  return oauthAccounts().findOne({ provider, providerUserId });
}

export async function findByUserId(userId: ObjectId): Promise<OAuthAccount | null> {
  return oauthAccounts().findOne({ userId });
}

export async function upsert(params: {
  userId: ObjectId;
  provider: string;
  providerUserId: string;
  providerUsername: string | null;
  accessToken: string;
  refreshToken?: string;
}): Promise<void> {
  const now = new Date();
  const set: {
    accessToken: string;
    providerUsername: string | null;
    updatedAt: Date;
    refreshToken?: string;
  } = {
    accessToken: params.accessToken,
    providerUsername: params.providerUsername,
    updatedAt: now,
  };

  if (params.refreshToken !== undefined) {
    set.refreshToken = params.refreshToken;
  }

  await oauthAccounts().updateOne(
    {
      provider: params.provider,
      providerUserId: params.providerUserId,
    },
    {
      $set: set,
      $setOnInsert: {
        _id: new ObjectId(),
        userId: params.userId,
        provider: params.provider,
        providerUserId: params.providerUserId,
        createdAt: now,
        refreshToken: params.refreshToken ?? null,
      },
    },
    { upsert: true }
  );
}

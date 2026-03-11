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
  potentialUserId: ObjectId;
  provider: string;
  providerUserId: string;
  providerUsername: string | null;
  accessToken: string;
  refreshToken?: string;
}): Promise<OAuthAccount> {
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

  const result = await oauthAccounts().findOneAndUpdate(
    {
      provider: params.provider,
      providerUserId: params.providerUserId,
    },
    {
      $set: set,
      $setOnInsert: {
        _id: new ObjectId(),
        userId: params.potentialUserId,
        provider: params.provider,
        providerUserId: params.providerUserId,
        createdAt: now,
        refreshToken: params.refreshToken ?? null,
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  if (!result) {
    throw new Error("findOneAndUpdate with upsert returned null");
  }

  return result;
}

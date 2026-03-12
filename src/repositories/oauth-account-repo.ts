import { ObjectId } from "mongodb";
import { DatabaseAccessor } from "../db/database-accessor.js";
import type { OAuthAccount } from "../models/documents.js";

export class OAuthAccountRepository {
  private constructor() {}

  static async findByProvider(provider: string, providerUserId: string): Promise<OAuthAccount | null> {
    return DatabaseAccessor.oauthAccounts().findOne({
      provider,
      providerUserId,
    });
  }

  static async findByUserId(userId: ObjectId): Promise<OAuthAccount | null> {
    return DatabaseAccessor.oauthAccounts().findOne({ userId });
  }

  static async upsert(params: {
    potentialUserId: ObjectId;
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
  }): Promise<OAuthAccount> {
    const now = new Date();

    const result = await DatabaseAccessor.oauthAccounts().findOneAndUpdate(
      {
        provider: params.provider,
        providerUserId: params.providerUserId,
      },
      {
        $set: {
          providerUsername: params.providerUsername,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: new ObjectId(),
          userId: params.potentialUserId,
          provider: params.provider,
          providerUserId: params.providerUserId,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    if (!result) {
      throw new Error("findOneAndUpdate with upsert returned null");
    }

    return result;
  }
}

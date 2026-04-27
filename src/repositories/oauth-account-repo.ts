import { Collection, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import type { OAuthAccount } from "../models/documents.js";
import { InternalServerError } from "../lib/errors.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

export class OAuthAccountRepository {
  readonly #collection: Collection<OAuthAccount>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts);
  }

  async findByProvider(provider: string, providerUserId: string): Promise<OAuthAccount | null> {
    return this.#collection.findOne({ provider, providerUserId });
  }

  async findByUserId(userId: string): Promise<OAuthAccount | null> {
    return this.#collection.findOne({ userId: new ObjectId(userId) });
  }

  async upsert(params: {
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
  }): Promise<{ account: OAuthAccount; potentialUserId: string }> {
    const now = new Date();
    const potentialUserId = new ObjectId();

    const $set: Record<string, unknown> = { updatedAt: now };
    if (params.providerUsername !== null) {
      $set.providerUsername = params.providerUsername;
    }

    const result = await this.#collection.findOneAndUpdate(
      {
        provider: params.provider,
        providerUserId: params.providerUserId,
      },
      {
        $set,
        $setOnInsert: {
          _id: new ObjectId(),
          userId: potentialUserId,
          provider: params.provider,
          providerUserId: params.providerUserId,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    if (!result) {
      throw new InternalServerError({ debugMessage: "findOneAndUpdate with upsert returned null" });
    }

    return {
      account: result,
      potentialUserId: potentialUserId.toHexString(),
    };
  }
}

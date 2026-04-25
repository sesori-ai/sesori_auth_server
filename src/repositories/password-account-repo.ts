import { Collection, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import type { PasswordAccount, PasswordAccountInput } from "../models/documents.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

export class PasswordAccountRepository {
  readonly #collection: Collection<PasswordAccount>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<PasswordAccount>(MongoDbDatabase.Auth, AuthDbCollection.PasswordAccounts);
  }

  async findByEmail(email: string): Promise<PasswordAccount | null> {
    return this.#collection.findOne({ email: email.toLowerCase() });
  }

  async create(account: PasswordAccountInput): Promise<PasswordAccount> {
    const now = new Date();
    const passwordAccount: PasswordAccount = {
      _id: new ObjectId(),
      userId: account.userId,
      email: account.email.toLowerCase(),
      passwordHash: account.passwordHash,
      createdAt: now,
      updatedAt: now,
    };

    await this.#collection.insertOne(passwordAccount);
    return passwordAccount;
  }

  async findByUserId(userId: string): Promise<PasswordAccount | null> {
    return this.#collection.findOne({ userId: new ObjectId(userId) });
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.#collection.updateOne({ userId: new ObjectId(userId) }, { $set: { passwordHash } });
  }
}

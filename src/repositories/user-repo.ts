import { Collection, ObjectId, type Filter } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { User } from "../models/documents.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";

export class UserRepository {
  readonly #collection: Collection<User>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
  }

  async findById(userId: string): Promise<User | null> {
    return this.#collection.findOne({ _id: new ObjectId(userId) });
  }

  async create(id?: string): Promise<User> {
    const now = new Date();
    const user: User = {
      _id: id ? new ObjectId(id) : new ObjectId(),
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.#collection.insertOne(user);
    return user;
  }

  async findIdBatch(afterUserId: string | null, batchLimit: number, createdAtOrBefore: Date): Promise<string[]> {
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1) {
      throw new InternalServerError({ debugMessage: "Invalid user batch limit" });
    }

    if (afterUserId !== null && !ObjectId.isValid(afterUserId)) {
      throw new InternalServerError({ debugMessage: "Invalid user pagination cursor" });
    }

    if (Number.isNaN(createdAtOrBefore.getTime())) {
      throw new InternalServerError({ debugMessage: "Invalid user creation cutoff" });
    }

    const filter: Filter<User> = {
      createdAt: { $lte: createdAtOrBefore },
      ...(afterUserId === null ? {} : { _id: { $gt: new ObjectId(afterUserId) } }),
    };
    const users = await this.#collection
      .find(filter, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(batchLimit)
      .toArray();
    return users.map((user) => user._id.toHexString());
  }

  async incrementTokenVersion(userId: string): Promise<void> {
    await this.#collection.updateOne(
      { _id: new ObjectId(userId) },
      { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } },
    );
  }
}

import { Collection, ObjectId } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
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

  async incrementTokenVersion(userId: string): Promise<void> {
    await this.#collection.updateOne(
      { _id: new ObjectId(userId) },
      { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } },
    );
  }
}

import { ObjectId } from "mongodb";
import { Collections } from "../db/collections.js";
import type { User } from "../models/documents.js";

export class UserRepository {
  private constructor() {}

  static async findById(userId: ObjectId): Promise<User | null> {
    return Collections.users().findOne({ _id: userId });
  }

  static async create(id?: ObjectId): Promise<User> {
    const now = new Date();
    const user: User = {
      _id: id ?? new ObjectId(),
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    };

    await Collections.users().insertOne(user);
    return user;
  }

  static async incrementTokenVersion(userId: ObjectId): Promise<void> {
    await Collections.users().updateOne(
      { _id: userId },
      { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } }
    );
  }
}

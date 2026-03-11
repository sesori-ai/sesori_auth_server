import { ObjectId } from "mongodb";
import { users } from "../db/collections.js";
import type { User } from "../models/documents.js";

export async function findById(userId: ObjectId): Promise<User | null> {
  return users().findOne({ _id: userId });
}

export async function create(id?: ObjectId): Promise<User> {
  const now = new Date();
  const user: User = {
    _id: id ?? new ObjectId(),
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  };

  await users().insertOne(user);
  return user;
}

export async function incrementTokenVersion(userId: ObjectId): Promise<void> {
  await users().updateOne(
    { _id: userId },
    { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } }
  );
}

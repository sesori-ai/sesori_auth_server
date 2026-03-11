import { ObjectId } from "mongodb";
import { users } from "../db/collections.js";
import type { User } from "../models/documents.js";

export async function findById(userId: ObjectId): Promise<User | null> {
  return users().findOne({ _id: userId });
}

export async function create(): Promise<User> {
  const now = new Date();
  const user: User = {
    _id: new ObjectId(),
    createdAt: now,
    updatedAt: now,
  };

  await users().insertOne(user);
  return user;
}

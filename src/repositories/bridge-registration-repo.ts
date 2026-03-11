import { ObjectId, type UpdateResult } from "mongodb";
import { bridgeRegistrations } from "../db/collections.js";
import type { BridgeRegistration } from "../models/documents.js";

export async function upsert(params: {
  userId: ObjectId;
  relayUrl: string;
  roomCode: string;
  publicKey: string;
}): Promise<UpdateResult<BridgeRegistration>> {
  return bridgeRegistrations().updateOne(
    { userId: params.userId },
    {
      $set: {
        relayUrl: params.relayUrl,
        roomCode: params.roomCode,
        publicKey: params.publicKey,
        lastHeartbeat: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

export async function findByUserId(
  userId: ObjectId
): Promise<BridgeRegistration | null> {
  return bridgeRegistrations().findOne({ userId });
}

export async function deleteByUserId(userId: ObjectId): Promise<void> {
  await bridgeRegistrations().deleteOne({ userId });
}

export async function updateHeartbeat(userId: ObjectId): Promise<number> {
  const result = await bridgeRegistrations().updateOne(
    { userId },
    { $set: { lastHeartbeat: new Date() } }
  );

  return result.matchedCount;
}

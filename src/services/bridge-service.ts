import { ObjectId } from "mongodb";
import {
  deleteByUserId,
  findByUserId,
  updateHeartbeat,
  upsert,
} from "../repositories/bridge-registration-repo.js";

export async function register(params: {
  userId: string;
  relayUrl: string;
  roomCode: string;
  publicKey: string;
}): Promise<{ bridgeId: string }> {
  const userObjectId = new ObjectId(params.userId);
  await upsert({
    userId: userObjectId,
    relayUrl: params.relayUrl,
    roomCode: params.roomCode,
    publicKey: params.publicKey,
  });

  const doc = await findByUserId(userObjectId);
  return { bridgeId: doc!._id.toHexString() };
}

export async function heartbeat(userId: string): Promise<boolean> {
  const matchedCount = await updateHeartbeat(new ObjectId(userId));
  return matchedCount > 0;
}

export async function deregister(userId: string): Promise<void> {
  await deleteByUserId(new ObjectId(userId));
}

export async function findByUser(userId: string): Promise<{
  bridgeId: string;
  relayUrl: string;
  roomCode: string;
  publicKey: string;
} | null> {
  const doc = await findByUserId(new ObjectId(userId));
  if (!doc) {
    return null;
  }

  const ttlSeconds = 60;
  const age = (Date.now() - doc.lastHeartbeat.getTime()) / 1000;
  if (age > ttlSeconds) {
    return null;
  }

  return {
    bridgeId: doc._id.toHexString(),
    relayUrl: doc.relayUrl,
    roomCode: doc.roomCode,
    publicKey: doc.publicKey,
  };
}

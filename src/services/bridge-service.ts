import { ObjectId } from "mongodb";
import { BridgeRegistrationRepository } from "../repositories/bridge-registration-repo.js";

export class BridgeService {
  private constructor() {}

  static async register(params: {
    userId: string;
    relayUrl: string;
    roomCode: string;
    publicKey: string;
  }): Promise<{ bridgeId: string }> {
    const userObjectId = new ObjectId(params.userId);
    await BridgeRegistrationRepository.upsert({
      userId: userObjectId,
      relayUrl: params.relayUrl,
      roomCode: params.roomCode,
      publicKey: params.publicKey,
    });

    const doc = await BridgeRegistrationRepository.findByUserId(userObjectId);
    return { bridgeId: doc!._id.toHexString() };
  }

  static async heartbeat(userId: string): Promise<boolean> {
    const matchedCount = await BridgeRegistrationRepository.updateHeartbeat(
      new ObjectId(userId)
    );
    return matchedCount > 0;
  }

  static async deregister(userId: string): Promise<void> {
    await BridgeRegistrationRepository.deleteByUserId(new ObjectId(userId));
  }

  static async findByUser(userId: string): Promise<{
    bridgeId: string;
    relayUrl: string;
    roomCode: string;
    publicKey: string;
  } | null> {
    const doc = await BridgeRegistrationRepository.findByUserId(new ObjectId(userId));
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
}

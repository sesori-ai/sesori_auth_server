import { ObjectId, type UpdateResult } from "mongodb";
import { Collections } from "../db/collections.js";
import type { BridgeRegistration } from "../models/documents.js";

export class BridgeRegistrationRepository {
  private constructor() {}

  static async upsert(params: {
    userId: ObjectId;
    relayUrl: string;
    roomCode: string;
    publicKey: string;
  }): Promise<UpdateResult<BridgeRegistration>> {
    return Collections.bridgeRegistrations().updateOne(
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

  static async findByUserId(
    userId: ObjectId
  ): Promise<BridgeRegistration | null> {
    return Collections.bridgeRegistrations().findOne({ userId });
  }

  static async deleteByUserId(userId: ObjectId): Promise<void> {
    await Collections.bridgeRegistrations().deleteOne({ userId });
  }

  static async updateHeartbeat(userId: ObjectId): Promise<number> {
    const result = await Collections.bridgeRegistrations().updateOne(
      { userId },
      { $set: { lastHeartbeat: new Date() } }
    );

    return result.matchedCount;
  }
}

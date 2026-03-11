import { ObjectId, type UpdateResult } from "mongodb";
import { DatabaseAccessor } from "../db/collections.js";
import type { BridgeRegistration } from "../models/documents.js";

export class BridgeRegistrationRepository {
  private constructor() {}

  static async upsert(params: {
    userId: ObjectId;
    relayUrl: string;
    roomCode: string;
    publicKey: string;
  }): Promise<UpdateResult<BridgeRegistration>> {
    return DatabaseAccessor.bridgeRegistrations().updateOne(
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
    return DatabaseAccessor.bridgeRegistrations().findOne({ userId });
  }

  static async deleteByUserId(userId: ObjectId): Promise<void> {
    await DatabaseAccessor.bridgeRegistrations().deleteOne({ userId });
  }

  static async updateHeartbeat(userId: ObjectId): Promise<number> {
    const result = await DatabaseAccessor.bridgeRegistrations().updateOne(
      { userId },
      { $set: { lastHeartbeat: new Date() } }
    );

    return result.matchedCount;
  }
}

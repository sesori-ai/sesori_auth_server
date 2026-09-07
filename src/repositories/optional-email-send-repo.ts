import { Collection, MongoServerError, ObjectId } from "mongodb";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { OptionalEmailSend } from "../models/documents.js";
import { OptionalEmailReminderKind, OptionalEmailSendStatus } from "../types/optional-email.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

export type OptionalEmailSendReservation =
  | { status: "reserved"; send: OptionalEmailSend }
  | { status: "duplicate"; send: OptionalEmailSend }
  | { status: "retry_expired"; send: OptionalEmailSend };

export class OptionalEmailSendRepository {
  readonly #collection: Collection<OptionalEmailSend>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<OptionalEmailSend>(
      MongoDbDatabase.Auth,
      AuthDbCollection.OptionalEmailSends,
    );
  }

  async reserve(input: {
    sendKey: string;
    userId: string;
    campaignId: string;
    reminderKind: OptionalEmailReminderKind;
    at: Date;
  }): Promise<OptionalEmailSendReservation> {
    this.#validate(input);
    const send: OptionalEmailSend = {
      _id: new ObjectId(),
      sendKey: input.sendKey,
      userId: new ObjectId(input.userId),
      campaignId: input.campaignId,
      reminderKind: input.reminderKind,
      status: OptionalEmailSendStatus.Reserved,
      attemptCount: 0,
      createdAt: input.at,
      updatedAt: input.at,
    };
    try {
      await this.#collection.insertOne(send);
      return { status: "reserved", send };
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) {
        throw error;
      }
      const existing = await this.findBySendKey({ sendKey: input.sendKey });
      if (!existing) {
        throw new InternalServerError({ debugMessage: "Optional email send reservation disappeared" });
      }
      if (existing.status === OptionalEmailSendStatus.Failed) {
        const firstAttemptMs = existing.firstProviderAttemptAt?.getTime();
        const retryAgeMs =
          firstAttemptMs === undefined ? Number.POSITIVE_INFINITY : input.at.getTime() - firstAttemptMs;
        if (retryAgeMs < 0 || retryAgeMs > 23 * 60 * 60 * 1_000) {
          return { status: "retry_expired", send: existing };
        }
        const reclaimed = await this.#collection.findOneAndUpdate(
          { _id: existing._id, status: OptionalEmailSendStatus.Failed },
          { $set: { status: OptionalEmailSendStatus.Reserved, updatedAt: input.at } },
          { returnDocument: "after" },
        );
        if (reclaimed) {
          return { status: "reserved", send: reclaimed };
        }
        const raced = await this.findBySendKey({ sendKey: input.sendKey });
        if (!raced) {
          throw new InternalServerError({ debugMessage: "Optional email retry reservation disappeared" });
        }
        return { status: "duplicate", send: raced };
      }
      if (existing.status === OptionalEmailSendStatus.DeferredDailyLimit) {
        const reclaimed = await this.#collection.findOneAndUpdate(
          { _id: existing._id, status: OptionalEmailSendStatus.DeferredDailyLimit },
          { $set: { status: OptionalEmailSendStatus.Reserved, updatedAt: input.at } },
          { returnDocument: "after" },
        );
        if (reclaimed) {
          return { status: "reserved", send: reclaimed };
        }
        const raced = await this.findBySendKey({ sendKey: input.sendKey });
        if (!raced) {
          throw new InternalServerError({ debugMessage: "Optional email deferred reservation disappeared" });
        }
        return { status: "duplicate", send: raced };
      }
      return { status: "duplicate", send: existing };
    }
  }

  async findBySendKey(input: { sendKey: string }): Promise<OptionalEmailSend | null> {
    if (!input.sendKey || input.sendKey.length > 256) {
      return null;
    }
    return this.#collection.findOne({ sendKey: input.sendKey });
  }

  async markInFlight(input: { sendKey: string; at: Date }): Promise<boolean> {
    if (!input.sendKey || input.sendKey.length > 256 || Number.isNaN(input.at.getTime())) {
      return false;
    }
    const result = await this.#collection.updateOne(
      { sendKey: input.sendKey, status: OptionalEmailSendStatus.Reserved },
      [
        {
          $set: {
            status: OptionalEmailSendStatus.InFlight,
            firstProviderAttemptAt: { $ifNull: ["$firstProviderAttemptAt", input.at] },
            lastProviderAttemptAt: input.at,
            updatedAt: input.at,
            attemptCount: { $add: ["$attemptCount", 1] },
          },
        },
      ],
    );
    return result.modifiedCount === 1;
  }

  async markAccepted(input: { sendKey: string; providerEmailId: string; at: Date }): Promise<boolean> {
    if (
      !input.sendKey ||
      input.sendKey.length > 256 ||
      !input.providerEmailId ||
      input.providerEmailId.length > 256 ||
      Number.isNaN(input.at.getTime())
    ) {
      return false;
    }
    const result = await this.#collection.updateOne(
      { sendKey: input.sendKey, status: OptionalEmailSendStatus.InFlight },
      {
        $set: {
          status: OptionalEmailSendStatus.Accepted,
          providerEmailId: input.providerEmailId,
          acceptedAt: input.at,
          updatedAt: input.at,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async markFailed(input: { sendKey: string; failureCode: string; at: Date }): Promise<boolean> {
    if (
      !input.sendKey ||
      input.sendKey.length > 256 ||
      !/^[a-z0-9_]{1,64}$/.test(input.failureCode) ||
      Number.isNaN(input.at.getTime())
    ) {
      return false;
    }
    const result = await this.#collection.updateOne(
      { sendKey: input.sendKey, status: OptionalEmailSendStatus.InFlight },
      {
        $set: {
          status: OptionalEmailSendStatus.Failed,
          lastFailureCode: input.failureCode,
          updatedAt: input.at,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async markBlocked(input: { sendKey: string; reason: string; at: Date }): Promise<boolean> {
    if (
      !input.sendKey ||
      input.sendKey.length > 256 ||
      !/^[a-z_]{1,64}$/.test(input.reason) ||
      Number.isNaN(input.at.getTime())
    ) {
      return false;
    }
    const result = await this.#collection.updateOne(
      { sendKey: input.sendKey, status: OptionalEmailSendStatus.Reserved },
      {
        $set: {
          status: OptionalEmailSendStatus.Blocked,
          lastBlockReason: input.reason,
          updatedAt: input.at,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async markDeferredForDailyLimit(input: { sendKey: string; at: Date }): Promise<boolean> {
    if (!input.sendKey || input.sendKey.length > 256 || Number.isNaN(input.at.getTime())) {
      return false;
    }
    const result = await this.#collection.updateOne(
      { sendKey: input.sendKey, status: OptionalEmailSendStatus.Reserved },
      {
        $set: {
          status: OptionalEmailSendStatus.DeferredDailyLimit,
          lastDeferralReason: "daily_limit",
          updatedAt: input.at,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async findUserIdByProviderEmailId(input: { providerEmailId: string }): Promise<string | null> {
    if (!input.providerEmailId || input.providerEmailId.length > 256) {
      return null;
    }
    const send = await this.#collection.findOne(
      { providerEmailId: input.providerEmailId, status: OptionalEmailSendStatus.Accepted },
      { projection: { userId: 1 } },
    );
    return send?.userId.toHexString() ?? null;
  }

  #validate(input: {
    sendKey: string;
    userId: string;
    campaignId: string;
    reminderKind: OptionalEmailReminderKind;
    at: Date;
  }): void {
    if (
      !input.sendKey ||
      input.sendKey.length > 256 ||
      !ObjectId.isValid(input.userId) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(input.campaignId) ||
      !Object.values(OptionalEmailReminderKind).includes(input.reminderKind) ||
      Number.isNaN(input.at.getTime())
    ) {
      throw new InternalServerError({ debugMessage: "Invalid optional email send reservation" });
    }
  }
}

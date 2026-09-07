import { Collection, MongoServerError, ObjectId } from "mongodb";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { OptionalEmailSend } from "../models/documents.js";
import {
  OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS,
  OPTIONAL_EMAIL_RESERVATION_LEASE_MS,
  OptionalEmailReminderKind,
  OptionalEmailSendBlockReason,
  OptionalEmailSendReservationOutcome,
  OptionalEmailSendStatus,
} from "../types/optional-email.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

export type OptionalEmailSendReservation =
  | { status: OptionalEmailSendReservationOutcome.Reserved; send: OptionalEmailSend; leaseId: string }
  | { status: OptionalEmailSendReservationOutcome.Duplicate; send: OptionalEmailSend }
  | { status: OptionalEmailSendReservationOutcome.RetryExpired; send: OptionalEmailSend };

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
    const userObjectId = new ObjectId(input.userId);
    const activeLeaseId = new ObjectId();
    const send: OptionalEmailSend = {
      _id: new ObjectId(),
      sendKey: input.sendKey,
      userId: userObjectId,
      campaignId: input.campaignId,
      reminderKind: input.reminderKind,
      status: OptionalEmailSendStatus.Reserved,
      activeLeaseId,
      attemptCount: 0,
      createdAt: input.at,
      updatedAt: input.at,
    };
    try {
      await this.#collection.insertOne(send);
      return { status: OptionalEmailSendReservationOutcome.Reserved, send, leaseId: activeLeaseId.toHexString() };
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) {
        throw error;
      }
      const existing = await this.findBySendKey({ sendKey: input.sendKey });
      if (!existing) {
        throw new InternalServerError({
          debugMessage: "Optional email send reservation collision could not be resolved",
        });
      }
      if (
        !existing.userId.equals(userObjectId) ||
        existing.campaignId !== input.campaignId ||
        existing.reminderKind !== input.reminderKind
      ) {
        throw new InternalServerError({ debugMessage: "Optional email send key identity mismatch" });
      }
      if (existing.status === OptionalEmailSendStatus.Reserved) {
        const reservationAgeMs = input.at.getTime() - existing.updatedAt.getTime();
        if (reservationAgeMs < 0 || reservationAgeMs <= OPTIONAL_EMAIL_RESERVATION_LEASE_MS) {
          return { status: OptionalEmailSendReservationOutcome.Duplicate, send: existing };
        }
        if (existing.firstProviderAttemptAt) {
          const retryAgeMs = input.at.getTime() - existing.firstProviderAttemptAt.getTime();
          if (retryAgeMs < 0 || retryAgeMs > OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS) {
            return { status: OptionalEmailSendReservationOutcome.RetryExpired, send: existing };
          }
        }
        const reclaimedLeaseId = new ObjectId();
        const reclaimed = await this.#collection.findOneAndUpdate(
          {
            _id: existing._id,
            status: OptionalEmailSendStatus.Reserved,
            updatedAt: existing.updatedAt,
          },
          { $set: { activeLeaseId: reclaimedLeaseId, updatedAt: input.at } },
          { returnDocument: "after" },
        );
        if (reclaimed) {
          return {
            status: OptionalEmailSendReservationOutcome.Reserved,
            send: reclaimed,
            leaseId: reclaimedLeaseId.toHexString(),
          };
        }
        const raced = await this.findBySendKey({ sendKey: input.sendKey });
        if (!raced) {
          throw new InternalServerError({ debugMessage: "Optional email stale reservation disappeared" });
        }
        return { status: OptionalEmailSendReservationOutcome.Duplicate, send: raced };
      }
      if (existing.status === OptionalEmailSendStatus.InFlight) {
        // Retry only with the same deterministic send key while the provider's
        // idempotency window can still collapse an uncertain prior request.
        const leaseAgeMs = input.at.getTime() - existing.updatedAt.getTime();
        if (leaseAgeMs < 0 || leaseAgeMs <= OPTIONAL_EMAIL_RESERVATION_LEASE_MS) {
          return { status: OptionalEmailSendReservationOutcome.Duplicate, send: existing };
        }
        const firstAttemptMs = existing.firstProviderAttemptAt?.getTime();
        const retryAgeMs =
          firstAttemptMs === undefined ? Number.POSITIVE_INFINITY : input.at.getTime() - firstAttemptMs;
        if (retryAgeMs < 0 || retryAgeMs > OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS) {
          return { status: OptionalEmailSendReservationOutcome.RetryExpired, send: existing };
        }
        const reclaimedLeaseId = new ObjectId();
        const reclaimed = await this.#collection.findOneAndUpdate(
          {
            _id: existing._id,
            status: OptionalEmailSendStatus.InFlight,
            updatedAt: existing.updatedAt,
          },
          {
            $set: {
              status: OptionalEmailSendStatus.Reserved,
              activeLeaseId: reclaimedLeaseId,
              updatedAt: input.at,
            },
          },
          { returnDocument: "after" },
        );
        if (reclaimed) {
          return {
            status: OptionalEmailSendReservationOutcome.Reserved,
            send: reclaimed,
            leaseId: reclaimedLeaseId.toHexString(),
          };
        }
        const raced = await this.findBySendKey({ sendKey: input.sendKey });
        if (!raced) {
          throw new InternalServerError({ debugMessage: "Optional email in-flight reservation disappeared" });
        }
        return { status: OptionalEmailSendReservationOutcome.Duplicate, send: raced };
      }
      if (existing.status === OptionalEmailSendStatus.Failed) {
        const firstAttemptMs = existing.firstProviderAttemptAt?.getTime();
        const retryAgeMs =
          firstAttemptMs === undefined ? Number.POSITIVE_INFINITY : input.at.getTime() - firstAttemptMs;
        if (retryAgeMs < 0 || retryAgeMs > OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS) {
          return { status: OptionalEmailSendReservationOutcome.RetryExpired, send: existing };
        }
        const reclaimedLeaseId = new ObjectId();
        const reclaimed = await this.#collection.findOneAndUpdate(
          { _id: existing._id, status: OptionalEmailSendStatus.Failed },
          {
            $set: {
              status: OptionalEmailSendStatus.Reserved,
              activeLeaseId: reclaimedLeaseId,
              updatedAt: input.at,
            },
          },
          { returnDocument: "after" },
        );
        if (reclaimed) {
          return {
            status: OptionalEmailSendReservationOutcome.Reserved,
            send: reclaimed,
            leaseId: reclaimedLeaseId.toHexString(),
          };
        }
        const raced = await this.findBySendKey({ sendKey: input.sendKey });
        if (!raced) {
          throw new InternalServerError({ debugMessage: "Optional email retry reservation disappeared" });
        }
        return { status: OptionalEmailSendReservationOutcome.Duplicate, send: raced };
      }
      if (existing.status === OptionalEmailSendStatus.DeferredDailyLimit) {
        if (existing.firstProviderAttemptAt) {
          const retryAgeMs = input.at.getTime() - existing.firstProviderAttemptAt.getTime();
          if (retryAgeMs < 0 || retryAgeMs > OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS) {
            return { status: OptionalEmailSendReservationOutcome.RetryExpired, send: existing };
          }
        }
        const reclaimedLeaseId = new ObjectId();
        const reclaimed = await this.#collection.findOneAndUpdate(
          { _id: existing._id, status: OptionalEmailSendStatus.DeferredDailyLimit },
          {
            $set: {
              status: OptionalEmailSendStatus.Reserved,
              activeLeaseId: reclaimedLeaseId,
              updatedAt: input.at,
            },
          },
          { returnDocument: "after" },
        );
        if (reclaimed) {
          return {
            status: OptionalEmailSendReservationOutcome.Reserved,
            send: reclaimed,
            leaseId: reclaimedLeaseId.toHexString(),
          };
        }
        const raced = await this.findBySendKey({ sendKey: input.sendKey });
        if (!raced) {
          throw new InternalServerError({ debugMessage: "Optional email deferred reservation disappeared" });
        }
        return { status: OptionalEmailSendReservationOutcome.Duplicate, send: raced };
      }
      return { status: OptionalEmailSendReservationOutcome.Duplicate, send: existing };
    }
  }

  async findBySendKey(input: { sendKey: string }): Promise<OptionalEmailSend | null> {
    if (!input.sendKey || input.sendKey.length > 256) {
      return null;
    }
    return this.#collection.findOne({ sendKey: input.sendKey });
  }

  async markInFlight(input: { sendKey: string; leaseId: string; at: Date }): Promise<boolean> {
    if (
      !input.sendKey ||
      input.sendKey.length > 256 ||
      !ObjectId.isValid(input.leaseId) ||
      Number.isNaN(input.at.getTime())
    ) {
      return false;
    }
    const earliestLeaseAt = new Date(input.at.getTime() - OPTIONAL_EMAIL_RESERVATION_LEASE_MS);
    const earliestProviderAttemptAt = new Date(
      input.at.getTime() - OPTIONAL_EMAIL_PROVIDER_IDEMPOTENCY_SAFETY_WINDOW_MS,
    );
    const result = await this.#collection.updateOne(
      {
        sendKey: input.sendKey,
        status: OptionalEmailSendStatus.Reserved,
        activeLeaseId: new ObjectId(input.leaseId),
        updatedAt: { $gte: earliestLeaseAt, $lte: input.at },
        $or: [
          { firstProviderAttemptAt: { $exists: false } },
          { firstProviderAttemptAt: { $gte: earliestProviderAttemptAt, $lte: input.at } },
        ],
      },
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

  async markAccepted(input: { sendKey: string; leaseId: string; providerEmailId: string; at: Date }): Promise<boolean> {
    if (
      !input.sendKey ||
      input.sendKey.length > 256 ||
      !ObjectId.isValid(input.leaseId) ||
      !input.providerEmailId ||
      input.providerEmailId.length > 256 ||
      Number.isNaN(input.at.getTime())
    ) {
      return false;
    }
    const result = await this.#collection.updateOne(
      {
        sendKey: input.sendKey,
        status: OptionalEmailSendStatus.InFlight,
        activeLeaseId: new ObjectId(input.leaseId),
      },
      {
        $set: {
          status: OptionalEmailSendStatus.Accepted,
          providerEmailId: input.providerEmailId,
          acceptedAt: input.at,
          updatedAt: input.at,
        },
        $unset: { activeLeaseId: "" },
      },
    );
    return result.modifiedCount === 1;
  }

  async markFailed(input: { sendKey: string; leaseId: string; failureCode: string; at: Date }): Promise<boolean> {
    if (
      !input.sendKey ||
      input.sendKey.length > 256 ||
      !ObjectId.isValid(input.leaseId) ||
      !/^[a-z0-9_]{1,64}$/.test(input.failureCode) ||
      Number.isNaN(input.at.getTime())
    ) {
      return false;
    }
    const result = await this.#collection.updateOne(
      {
        sendKey: input.sendKey,
        status: OptionalEmailSendStatus.InFlight,
        activeLeaseId: new ObjectId(input.leaseId),
      },
      {
        $set: {
          status: OptionalEmailSendStatus.Failed,
          lastFailureCode: input.failureCode,
          updatedAt: input.at,
        },
        $unset: { activeLeaseId: "" },
      },
    );
    return result.modifiedCount === 1;
  }

  async markBlocked(input: {
    sendKey: string;
    leaseId: string;
    reason: OptionalEmailSendBlockReason;
    at: Date;
  }): Promise<boolean> {
    if (
      !input.sendKey ||
      input.sendKey.length > 256 ||
      !ObjectId.isValid(input.leaseId) ||
      !Object.values(OptionalEmailSendBlockReason).includes(input.reason) ||
      Number.isNaN(input.at.getTime())
    ) {
      return false;
    }
    const result = await this.#collection.updateOne(
      {
        sendKey: input.sendKey,
        status: OptionalEmailSendStatus.Reserved,
        activeLeaseId: new ObjectId(input.leaseId),
      },
      {
        $set: {
          status: OptionalEmailSendStatus.Blocked,
          lastBlockReason: input.reason,
          updatedAt: input.at,
        },
        $unset: { activeLeaseId: "" },
      },
    );
    return result.modifiedCount === 1;
  }

  async markDeferredForDailyLimit(input: { sendKey: string; leaseId: string; at: Date }): Promise<boolean> {
    if (
      !input.sendKey ||
      input.sendKey.length > 256 ||
      !ObjectId.isValid(input.leaseId) ||
      Number.isNaN(input.at.getTime())
    ) {
      return false;
    }
    const result = await this.#collection.updateOne(
      {
        sendKey: input.sendKey,
        status: OptionalEmailSendStatus.Reserved,
        activeLeaseId: new ObjectId(input.leaseId),
      },
      {
        $set: {
          status: OptionalEmailSendStatus.DeferredDailyLimit,
          lastDeferralReason: "daily_limit",
          updatedAt: input.at,
        },
        $unset: { activeLeaseId: "" },
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

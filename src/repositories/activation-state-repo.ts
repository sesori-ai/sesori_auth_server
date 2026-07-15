import { Collection, MongoServerError, ObjectId, type Filter, type Sort } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { ActivationState } from "../models/documents.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

export type ActivationMilestoneUpdate = {
  mobileSetupAt?: Date;
  bridgeSetupAt?: Date;
  firstSessionAt?: Date;
};

export type ActivationMilestoneRecordResult = {
  state: ActivationState;
  recorded: ActivationMilestoneUpdate;
};

export type ActivationReminderKind = "bridge_1" | "bridge_2" | "session";

export type DueActivationReminder = {
  userId: string;
  baselineAt: Date;
};

function reminderEligibilityFilter(kind: ActivationReminderKind, cutoff: Date): Filter<ActivationState> {
  switch (kind) {
    case "bridge_1":
      return {
        bridgeSetupAt: null,
        bridgeReminder1SentAt: null,
        bridgeReminderBaseAt: { $lte: cutoff },
      };
    case "bridge_2":
      return {
        bridgeSetupAt: null,
        bridgeReminder2SentAt: null,
        bridgeReminderBaseAt: { $lte: cutoff },
      };
    case "session":
      return {
        firstSessionAt: null,
        sessionReminderSentAt: null,
        sessionReminderBaseAt: { $lte: cutoff },
      };
  }
}

export class ActivationStateRepository {
  readonly #collection: Collection<ActivationState>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<ActivationState>(MongoDbDatabase.Auth, AuthDbCollection.ActivationStates);
  }

  async findByUserId(userId: string): Promise<ActivationState | null> {
    if (!ObjectId.isValid(userId)) {
      return null;
    }
    return this.#collection.findOne({ userId: new ObjectId(userId) });
  }

  async createIfAbsent(userId: string, at = new Date()): Promise<ActivationState> {
    if (!ObjectId.isValid(userId)) {
      throw new InternalServerError({ debugMessage: "Invalid activation state userId" });
    }
    const objectUserId = new ObjectId(userId);
    try {
      const state = await this.#collection.findOneAndUpdate(
        { userId: objectUserId },
        {
          $setOnInsert: {
            _id: new ObjectId(),
            userId: objectUserId,
            mobileSetupAt: null,
            bridgeSetupAt: null,
            firstSessionAt: null,
            bridgeReminderBaseAt: null,
            sessionReminderBaseAt: null,
            bridgeReminder1SentAt: null,
            bridgeReminder2SentAt: null,
            sessionReminderSentAt: null,
            backfilledAt: null,
            createdAt: at,
            updatedAt: at,
          },
        },
        { upsert: true, returnDocument: "after" },
      );

      if (!state) {
        throw new InternalServerError({ debugMessage: "Failed to create activation state" });
      }
      return state;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        const winner = await this.#collection.findOne({ userId: objectUserId });
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
  }

  async recordMilestones(userId: string, update: ActivationMilestoneUpdate, at = new Date()): Promise<ActivationState> {
    return (await this.recordMilestonesWithResult(userId, update, at)).state;
  }

  async recordMilestonesWithResult(
    userId: string,
    update: ActivationMilestoneUpdate,
    at = new Date(),
  ): Promise<ActivationMilestoneRecordResult> {
    await this.createIfAbsent(userId, at);
    const objectUserId = new ObjectId(userId);
    const mobileCandidate = update.mobileSetupAt ?? null;
    const bridgeCandidate = update.bridgeSetupAt ?? null;
    const sessionCandidate = update.firstSessionAt ?? null;
    const previous = await this.#collection.findOneAndUpdate(
      { userId: objectUserId },
      [
        {
          $set: {
            mobileSetupAt: { $ifNull: ["$mobileSetupAt", mobileCandidate] },
            bridgeSetupAt: { $ifNull: ["$bridgeSetupAt", bridgeCandidate] },
            firstSessionAt: {
              $cond: [
                { $eq: [sessionCandidate, null] },
                "$firstSessionAt",
                {
                  $cond: [
                    {
                      $or: [{ $eq: ["$firstSessionAt", null] }, { $lt: [sessionCandidate, "$firstSessionAt"] }],
                    },
                    sessionCandidate,
                    "$firstSessionAt",
                  ],
                },
              ],
            },
            bridgeReminderBaseAt: {
              $ifNull: ["$bridgeReminderBaseAt", { $ifNull: ["$mobileSetupAt", mobileCandidate] }],
            },
            updatedAt: at,
          },
        },
        {
          $set: {
            sessionReminderBaseAt: {
              $ifNull: [
                "$sessionReminderBaseAt",
                {
                  $cond: [
                    {
                      $and: [{ $ne: ["$mobileSetupAt", null] }, { $ne: ["$bridgeSetupAt", null] }],
                    },
                    {
                      $cond: [{ $gte: ["$mobileSetupAt", "$bridgeSetupAt"] }, "$mobileSetupAt", "$bridgeSetupAt"],
                    },
                    null,
                  ],
                },
              ],
            },
          },
        },
      ],
      { returnDocument: "before" },
    );

    if (!previous) {
      throw new InternalServerError({ debugMessage: "Failed to record activation milestones" });
    }

    // Reproduce the two update-pipeline stages against the atomically returned
    // pre-image so callers receive the state written by this operation and can
    // identify which first milestones this operation actually claimed.
    const mobileSetupAt = previous.mobileSetupAt ?? mobileCandidate;
    const bridgeSetupAt = previous.bridgeSetupAt ?? bridgeCandidate;
    const firstSessionAt =
      sessionCandidate && (!previous.firstSessionAt || sessionCandidate < previous.firstSessionAt)
        ? sessionCandidate
        : previous.firstSessionAt;
    const bridgeReminderBaseAt = previous.bridgeReminderBaseAt ?? previous.mobileSetupAt ?? mobileCandidate;
    const sessionReminderBaseAt =
      previous.sessionReminderBaseAt ??
      (mobileSetupAt && bridgeSetupAt ? (mobileSetupAt >= bridgeSetupAt ? mobileSetupAt : bridgeSetupAt) : null);

    return {
      state: {
        ...previous,
        mobileSetupAt,
        bridgeSetupAt,
        firstSessionAt,
        bridgeReminderBaseAt,
        sessionReminderBaseAt,
        updatedAt: at,
      },
      recorded: {
        mobileSetupAt: !previous.mobileSetupAt && mobileCandidate ? mobileCandidate : undefined,
        bridgeSetupAt: !previous.bridgeSetupAt && bridgeCandidate ? bridgeCandidate : undefined,
        firstSessionAt: !previous.firstSessionAt && sessionCandidate ? sessionCandidate : undefined,
      },
    };
  }

  async findDueReminders(
    kind: ActivationReminderKind,
    cutoff: Date,
    batchLimit: number,
  ): Promise<DueActivationReminder[]> {
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1) {
      throw new InternalServerError({ debugMessage: "Invalid activation reminder batch limit" });
    }

    const sort: Sort = kind === "session" ? { sessionReminderBaseAt: 1 } : { bridgeReminderBaseAt: 1 };
    const states = await this.#collection
      .find(reminderEligibilityFilter(kind, cutoff))
      .sort(sort)
      .limit(batchLimit)
      .toArray();

    return states.map((state) => {
      const baselineAt = kind === "session" ? state.sessionReminderBaseAt : state.bridgeReminderBaseAt;
      if (!baselineAt) {
        throw new InternalServerError({ debugMessage: "Due activation reminder is missing its baseline" });
      }
      return { userId: state.userId.toHexString(), baselineAt };
    });
  }

  async isReminderStillDue(userId: string, kind: ActivationReminderKind, cutoff: Date): Promise<boolean> {
    if (!ObjectId.isValid(userId)) {
      return false;
    }
    const state = await this.#collection.findOne(
      { ...reminderEligibilityFilter(kind, cutoff), userId: new ObjectId(userId) },
      { projection: { _id: 1 } },
    );
    return state !== null;
  }

  async markReminderSentIfStillDue(
    userId: string,
    kind: ActivationReminderKind,
    cutoff: Date,
    sentAt = new Date(),
  ): Promise<boolean> {
    if (!ObjectId.isValid(userId)) {
      return false;
    }
    const filter = { ...reminderEligibilityFilter(kind, cutoff), userId: new ObjectId(userId) };
    const update =
      kind === "bridge_1"
        ? { $set: { bridgeReminder1SentAt: sentAt, updatedAt: sentAt } }
        : kind === "bridge_2"
          ? { $set: { bridgeReminder2SentAt: sentAt, updatedAt: sentAt } }
          : { $set: { sessionReminderSentAt: sentAt, updatedAt: sentAt } };
    const result = await this.#collection.updateOne(filter, update);
    return result.modifiedCount === 1;
  }
}

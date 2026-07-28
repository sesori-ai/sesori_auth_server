import { Collection, ObjectId, type Filter } from "mongodb";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { User } from "../models/documents.js";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";
import {
  ProductAnalyticsPreference,
  ProductAnalyticsPreferenceUpdateOutcome,
  productAnalyticsExpectedRevisionSchema,
  productAnalyticsOperationIdSchema,
  productAnalyticsPreferenceRevisionSchema,
  productAnalyticsPreferenceSchema,
  type ProductAnalyticsPreferenceRecord,
  type ProductAnalyticsPreferenceUpdateResult,
} from "../types/product-analytics.js";

export type ProductAnalyticsPreferenceBackfillResult = {
  matchedCount: number;
  modifiedCount: number;
};

export const productAnalyticsPreferenceBackfillMaxBatchLimit = 1_000;

const missingProductAnalyticsPreferenceFilter: Filter<User> = {
  $or: [
    { productAnalyticsPreference: { $exists: false } },
    { productAnalyticsPreferenceUpdatedAt: { $exists: false } },
    { productAnalyticsPreferenceRevision: { $exists: false } },
    { productAnalyticsPreferenceLastOperationId: { $exists: false } },
  ],
};

function productAnalyticsPreferenceRecordFrom(input: { user: User }): ProductAnalyticsPreferenceRecord {
  const { user } = input;
  const preferenceResult = productAnalyticsPreferenceSchema.safeParse(
    user.productAnalyticsExportSuppressedAt
      ? ProductAnalyticsPreference.Disabled
      : (user.productAnalyticsPreference ?? ProductAnalyticsPreference.Enabled),
  );
  const revisionResult = productAnalyticsPreferenceRevisionSchema.safeParse(
    user.productAnalyticsPreferenceRevision ?? 1,
  );
  const updatedAt = user.productAnalyticsPreferenceUpdatedAt ?? user.createdAt;

  if (!preferenceResult.success || !revisionResult.success || Number.isNaN(updatedAt.getTime())) {
    throw new InternalServerError({ debugMessage: "Invalid stored product analytics preference" });
  }

  return {
    preference: preferenceResult.data,
    updatedAt,
    revision: revisionResult.data,
  };
}

export class UserRepository {
  readonly #collection: Collection<User>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
  }

  async findById(userId: string): Promise<User | null> {
    return this.#collection.findOne({ _id: new ObjectId(userId) });
  }

  async create(id?: string): Promise<User> {
    const now = new Date();
    const user: User = {
      _id: id ? new ObjectId(id) : new ObjectId(),
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
      productAnalyticsPreference: ProductAnalyticsPreference.Enabled,
      productAnalyticsPreferenceUpdatedAt: now,
      productAnalyticsPreferenceRevision: 1,
      productAnalyticsPreferenceLastOperationId: null,
    };

    await this.#collection.insertOne(user);
    return user;
  }

  async findProductAnalyticsPreference(input: { userId: string }): Promise<ProductAnalyticsPreferenceRecord | null> {
    if (!ObjectId.isValid(input.userId)) {
      return null;
    }

    const user = await this.#collection.findOne({ _id: new ObjectId(input.userId) });
    return user ? productAnalyticsPreferenceRecordFrom({ user }) : null;
  }

  async updateProductAnalyticsPreference(input: {
    userId: string;
    preference: ProductAnalyticsPreference;
    expectedRevision: number;
    operationId: string;
  }): Promise<ProductAnalyticsPreferenceUpdateResult | null> {
    if (!ObjectId.isValid(input.userId)) {
      return null;
    }

    const revisionResult = productAnalyticsExpectedRevisionSchema.safeParse(input.expectedRevision);
    const preferenceResult = productAnalyticsPreferenceSchema.safeParse(input.preference);
    const operationIdResult = productAnalyticsOperationIdSchema.safeParse(input.operationId);
    const updatedAt = new Date();
    if (
      !revisionResult.success ||
      !preferenceResult.success ||
      !operationIdResult.success ||
      Number.isNaN(updatedAt.getTime())
    ) {
      throw new InternalServerError({ debugMessage: "Invalid product analytics preference update" });
    }

    const currentRevision = { $ifNull: ["$productAnalyticsPreferenceRevision", 1] };
    const currentPreference = {
      $ifNull: ["$productAnalyticsPreference", ProductAnalyticsPreference.Enabled],
    };
    const currentOperationId = { $ifNull: ["$productAnalyticsPreferenceLastOperationId", null] };
    const isSameOperationId = { $eq: [currentOperationId, input.operationId] };
    const isMatchingDuplicateOperation = {
      $and: [
        isSameOperationId,
        { $eq: [currentPreference, input.preference] },
        { $eq: [currentRevision, { $add: [input.expectedRevision, 1] }] },
      ],
    };
    const isNewOperationAtExpectedRevision = {
      $and: [{ $ne: [currentOperationId, input.operationId] }, { $eq: [currentRevision, input.expectedRevision] }],
    };
    const filter: Filter<User> = {
      _id: new ObjectId(input.userId),
      ...(input.preference === ProductAnalyticsPreference.Enabled ? { productAnalyticsExportSuppressedAt: null } : {}),
      $expr: {
        $or: [isMatchingDuplicateOperation, isNewOperationAtExpectedRevision],
      },
    };

    const updated = await this.#collection.findOneAndUpdate(
      filter,
      [
        {
          $set: {
            productAnalyticsPreference: {
              $cond: [isMatchingDuplicateOperation, currentPreference, input.preference],
            },
            productAnalyticsPreferenceUpdatedAt: {
              $cond: [
                isMatchingDuplicateOperation,
                { $ifNull: ["$productAnalyticsPreferenceUpdatedAt", "$createdAt"] },
                updatedAt,
              ],
            },
            productAnalyticsPreferenceRevision: {
              $cond: [isMatchingDuplicateOperation, currentRevision, { $add: [currentRevision, 1] }],
            },
            productAnalyticsPreferenceLastOperationId: {
              $cond: [isMatchingDuplicateOperation, currentOperationId, input.operationId],
            },
            updatedAt: { $cond: [isMatchingDuplicateOperation, "$updatedAt", updatedAt] },
          },
        },
      ],
      { returnDocument: "after" },
    );

    if (updated) {
      return {
        outcome: ProductAnalyticsPreferenceUpdateOutcome.Updated,
        record: productAnalyticsPreferenceRecordFrom({ user: updated }),
      };
    }

    const current = await this.#collection.findOne({ _id: new ObjectId(input.userId) });
    if (!current) {
      return null;
    }

    return {
      outcome: ProductAnalyticsPreferenceUpdateOutcome.Conflict,
      record: productAnalyticsPreferenceRecordFrom({ user: current }),
    };
  }

  async findProductAnalyticsPreferenceBackfillBatch(input: {
    afterUserId: string | null;
    batchLimit: number;
  }): Promise<string[]> {
    if (
      !Number.isSafeInteger(input.batchLimit) ||
      input.batchLimit < 1 ||
      input.batchLimit > productAnalyticsPreferenceBackfillMaxBatchLimit
    ) {
      throw new InternalServerError({ debugMessage: "Invalid preference backfill batch limit" });
    }
    if (input.afterUserId !== null && !ObjectId.isValid(input.afterUserId)) {
      throw new InternalServerError({ debugMessage: "Invalid preference backfill cursor" });
    }

    const users = await this.#collection
      .find(
        {
          ...missingProductAnalyticsPreferenceFilter,
          ...(input.afterUserId === null ? {} : { _id: { $gt: new ObjectId(input.afterUserId) } }),
        },
        { projection: { _id: 1 } },
      )
      .sort({ _id: 1 })
      .limit(input.batchLimit)
      .toArray();
    return users.map((user) => user._id.toHexString());
  }

  async backfillProductAnalyticsPreferenceBatch(input: {
    userIds: string[];
  }): Promise<ProductAnalyticsPreferenceBackfillResult> {
    if (input.userIds.length < 1 || input.userIds.length > productAnalyticsPreferenceBackfillMaxBatchLimit) {
      throw new InternalServerError({ debugMessage: "Invalid preference backfill batch size" });
    }
    if (input.userIds.some((userId) => !ObjectId.isValid(userId))) {
      throw new InternalServerError({ debugMessage: "Invalid preference backfill user ID" });
    }

    const result = await this.#collection.updateMany(
      {
        ...missingProductAnalyticsPreferenceFilter,
        _id: { $in: input.userIds.map((userId) => new ObjectId(userId)) },
      },
      [
        {
          $set: {
            productAnalyticsPreference: {
              $cond: [
                { $ne: [{ $ifNull: ["$productAnalyticsExportSuppressedAt", null] }, null] },
                ProductAnalyticsPreference.Disabled,
                { $ifNull: ["$productAnalyticsPreference", ProductAnalyticsPreference.Enabled] },
              ],
            },
            productAnalyticsPreferenceUpdatedAt: {
              $ifNull: ["$productAnalyticsPreferenceUpdatedAt", "$createdAt"],
            },
            productAnalyticsPreferenceRevision: {
              $ifNull: ["$productAnalyticsPreferenceRevision", 1],
            },
            productAnalyticsPreferenceLastOperationId: {
              $ifNull: ["$productAnalyticsPreferenceLastOperationId", null],
            },
          },
        },
      ],
    );
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  async findIdBatch(afterUserId: string | null, batchLimit: number, createdAtOrBefore: Date): Promise<string[]> {
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1) {
      throw new InternalServerError({ debugMessage: "Invalid user batch limit" });
    }

    if (afterUserId !== null && !ObjectId.isValid(afterUserId)) {
      throw new InternalServerError({ debugMessage: "Invalid user pagination cursor" });
    }

    if (Number.isNaN(createdAtOrBefore.getTime())) {
      throw new InternalServerError({ debugMessage: "Invalid user creation cutoff" });
    }

    const filter: Filter<User> = {
      createdAt: { $lte: createdAtOrBefore },
      ...(afterUserId === null ? {} : { _id: { $gt: new ObjectId(afterUserId) } }),
    };
    const users = await this.#collection
      .find(filter, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(batchLimit)
      .toArray();
    return users.map((user) => user._id.toHexString());
  }

  async incrementTokenVersion(userId: string): Promise<void> {
    await this.#collection.updateOne(
      { _id: new ObjectId(userId) },
      { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } },
    );
  }
}

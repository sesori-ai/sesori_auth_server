import { Collection, MongoServerError } from "mongodb";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import type { OptionalEmailDailyQuota } from "../models/documents.js";
import { OPTIONAL_EMAIL_MAX_DAILY_CAP } from "../types/optional-email.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

export type OptionalEmailDailyQuotaResult = {
  date: string;
  used: number;
  remaining: number;
};

export class OptionalEmailDailyQuotaRepository {
  readonly #collection: Collection<OptionalEmailDailyQuota>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<OptionalEmailDailyQuota>(
      MongoDbDatabase.Auth,
      AuthDbCollection.OptionalEmailDailyQuota,
    );
  }

  async reserve(input: { at: Date; dailyCap: number }): Promise<OptionalEmailDailyQuotaResult & { reserved: boolean }> {
    const date = this.#validateAndDate(input);
    await this.#ensureDay({ date, at: input.at });
    const updated = await this.#collection.findOneAndUpdate(
      { _id: date, used: { $lt: input.dailyCap } },
      { $inc: { used: 1 }, $set: { updatedAt: input.at } },
      { returnDocument: "after" },
    );
    if (!updated) {
      return { reserved: false, ...(await this.getUsage(input)) };
    }
    return {
      reserved: true,
      date,
      used: updated.used,
      remaining: input.dailyCap - updated.used,
    };
  }

  async getUsage(input: { at: Date; dailyCap: number }): Promise<OptionalEmailDailyQuotaResult> {
    const date = this.#validateAndDate(input);
    const row = await this.#collection.findOne({ _id: date });
    const used = row?.used ?? 0;
    return { date, used, remaining: Math.max(0, input.dailyCap - used) };
  }

  async #ensureDay(input: { date: string; at: Date }): Promise<void> {
    try {
      await this.#collection.updateOne(
        { _id: input.date },
        {
          $setOnInsert: {
            _id: input.date,
            used: 0,
            createdAt: input.at,
            updatedAt: input.at,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) {
        throw error;
      }
    }
  }

  #validateAndDate(input: { at: Date; dailyCap: number }): string {
    if (
      Number.isNaN(input.at.getTime()) ||
      !Number.isInteger(input.dailyCap) ||
      input.dailyCap < 1 ||
      input.dailyCap > OPTIONAL_EMAIL_MAX_DAILY_CAP
    ) {
      throw new InternalServerError({ debugMessage: "Invalid optional email daily quota input" });
    }
    return input.at.toISOString().slice(0, 10);
  }
}

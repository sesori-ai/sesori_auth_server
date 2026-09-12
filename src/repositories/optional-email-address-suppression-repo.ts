import { Collection, MongoServerError } from "mongodb";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { InternalServerError } from "../lib/errors.js";
import { optionalEmailAddressSuppressionSchema, type OptionalEmailAddressSuppression } from "../models/documents.js";
import {
  type OptionalEmailAddressKey,
  OptionalEmailAddressKeyVersion,
  OptionalEmailBlockReason,
  OptionalEmailSuppressionReason,
} from "../types/optional-email.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

const ADDRESS_KEY_PATTERN = /^[a-f0-9]{64}$/;

export class OptionalEmailAddressSuppressionRepository {
  readonly #collection: Collection<OptionalEmailAddressSuppression>;

  constructor(accessor: MongoDbAccessor) {
    this.#collection = accessor.getCollection<OptionalEmailAddressSuppression>(
      MongoDbDatabase.Auth,
      AuthDbCollection.OptionalEmailAddressSuppressions,
    );
  }

  async findBlockReason(input: {
    addressKeys: readonly OptionalEmailAddressKey[];
  }): Promise<OptionalEmailBlockReason | null> {
    this.#assertAddressKeys(input.addressKeys);
    const unvalidatedRecords = await this.#collection
      .find({
        $or: input.addressKeys.map((addressKey) => ({
          addressKeyVersion: addressKey.addressKeyVersion,
          addressKey: addressKey.addressKey,
        })),
      })
      .toArray();
    const records = unvalidatedRecords.map((record) => {
      const parsed = optionalEmailAddressSuppressionSchema.safeParse(record);
      if (!parsed.success) {
        throw new InternalServerError({
          debugMessage: "Malformed optional email address suppression record",
          nestedError: parsed.error,
        });
      }

      return parsed.data;
    });
    if (records.some((record) => record.unsubscribedAt !== undefined)) {
      return OptionalEmailBlockReason.Unsubscribed;
    }

    if (records.some((record) => record.suppressedAt !== undefined)) {
      return OptionalEmailBlockReason.Suppressed;
    }

    return null;
  }

  async unsubscribe(input: {
    addressKey: OptionalEmailAddressKey;
    at: Date;
  }): Promise<OptionalEmailAddressSuppression> {
    this.#assertInput(input);
    return this.#upsertOnce({
      ...input,
      fields: { unsubscribedAt: { $ifNull: ["$unsubscribedAt", input.at] } },
    });
  }

  async suppress(input: {
    addressKey: OptionalEmailAddressKey;
    reason: OptionalEmailSuppressionReason;
    at: Date;
  }): Promise<OptionalEmailAddressSuppression> {
    this.#assertInput(input);
    if (!Object.values(OptionalEmailSuppressionReason).includes(input.reason)) {
      throw new InternalServerError({ debugMessage: "Invalid optional email address suppression reason" });
    }

    return this.#upsertOnce({
      ...input,
      fields: {
        suppressedAt: { $ifNull: ["$suppressedAt", input.at] },
        suppressionReason: { $ifNull: ["$suppressionReason", input.reason] },
      },
    });
  }

  async #upsertOnce(input: {
    addressKey: OptionalEmailAddressKey;
    at: Date;
    fields: Record<string, unknown>;
  }): Promise<OptionalEmailAddressSuppression> {
    const filter = {
      addressKeyVersion: input.addressKey.addressKeyVersion,
      addressKey: input.addressKey.addressKey,
    };
    const update = [
      {
        $set: {
          ...input.fields,
          createdAt: { $ifNull: ["$createdAt", input.at] },
          updatedAt: input.at,
        },
      },
    ];
    try {
      const record = await this.#collection.findOneAndUpdate(filter, update, {
        upsert: true,
        returnDocument: "after",
      });
      if (record) {
        return record;
      }
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) {
        throw error;
      }

      const record = await this.#collection.findOneAndUpdate(filter, update, {
        upsert: false,
        returnDocument: "after",
      });
      if (record) {
        return record;
      }
    }

    const winner = await this.#collection.findOne(filter);
    if (!winner) {
      throw new InternalServerError({ debugMessage: "Failed to persist optional email address suppression" });
    }

    return winner;
  }

  #assertInput(input: { addressKey: OptionalEmailAddressKey; at: Date }): void {
    this.#assertAddressKeys([input.addressKey]);
    if (!(input.at instanceof Date) || Number.isNaN(input.at.getTime())) {
      throw new InternalServerError({ debugMessage: "Invalid optional email address suppression input" });
    }
  }

  #assertAddressKeys(addressKeys: readonly OptionalEmailAddressKey[]): void {
    const versions = new Set(addressKeys.map((addressKey) => addressKey.addressKeyVersion));
    if (
      addressKeys.length === 0 ||
      versions.size !== addressKeys.length ||
      addressKeys.some(
        (addressKey) =>
          !Object.values(OptionalEmailAddressKeyVersion).includes(addressKey.addressKeyVersion) ||
          !ADDRESS_KEY_PATTERN.test(addressKey.addressKey),
      )
    ) {
      throw new InternalServerError({ debugMessage: "Invalid optional email address key" });
    }
  }
}

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MongoServerError, ObjectId } from "mongodb";
import type { MongoDbAccessor } from "../../src/db/mongo-db-accessor.js";
import { InternalServerError } from "../../src/lib/errors.js";
import type { OptionalEmailAddressSuppression } from "../../src/models/documents.js";
import { deriveOptionalEmailAddressKey } from "../../src/lib/optional-email-address-key.js";
import { OptionalEmailAddressSuppressionRepository } from "../../src/repositories/optional-email-address-suppression-repo.js";
import {
  OptionalEmailAddressKeyVersion,
  OptionalEmailBlockReason,
  OptionalEmailSuppressionReason,
} from "../../src/types/optional-email.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

const fixtureSecret = "s".repeat(32);

describe("OptionalEmailAddressSuppressionRepository", () => {
  let ctx: TestContext;
  let repository: OptionalEmailAddressSuppressionRepository;

  before(async () => {
    ctx = await createTestApp();
    repository = new OptionalEmailAddressSuppressionRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("persists an address-level unsubscribe without a raw address or user id", async () => {
    const addressKey = deriveOptionalEmailAddressKey({
      address: " Shared@Example.test ",
      secret: fixtureSecret,
      version: OptionalEmailAddressKeyVersion.V1,
    });
    const at = new Date("2026-09-12T12:00:00.000Z");

    await repository.unsubscribe({ addressKey, at });

    const stored = await ctx.dbAccessor
      .getCollection<OptionalEmailAddressSuppression>(
        MongoDbDatabase.Auth,
        AuthDbCollection.OptionalEmailAddressSuppressions,
      )
      .findOne(addressKey);
    assert.equal(stored?.unsubscribedAt?.toISOString(), at.toISOString());
    assert.equal("email" in (stored ?? {}), false);
    assert.equal("address" in (stored ?? {}), false);
    assert.equal("userId" in (stored ?? {}), false);
    assert.equal(
      await repository.findBlockReason({ addressKeys: [addressKey] }),
      OptionalEmailBlockReason.Unsubscribed,
    );
  });

  it("does not retain extra raw address or user id properties from a structurally typed key", async () => {
    const addressKey = {
      ...deriveOptionalEmailAddressKey({
        address: "tainted@example.test",
        secret: fixtureSecret,
        version: OptionalEmailAddressKeyVersion.V1,
      }),
      address: "tainted@example.test",
      userId: new ObjectId(),
    };

    await repository.unsubscribe({ addressKey, at: new Date("2026-09-12T12:30:00.000Z") });

    const stored = await ctx.dbAccessor
      .getCollection<OptionalEmailAddressSuppression>(
        MongoDbDatabase.Auth,
        AuthDbCollection.OptionalEmailAddressSuppressions,
      )
      .findOne({
        addressKeyVersion: addressKey.addressKeyVersion,
        addressKey: addressKey.addressKey,
      });
    assert.equal("address" in (stored ?? {}), false);
    assert.equal("userId" in (stored ?? {}), false);
  });

  it("persists hard-bounce, complaint, and provider suppression blockers", async () => {
    for (const reason of [
      OptionalEmailSuppressionReason.HardBounce,
      OptionalEmailSuppressionReason.Complaint,
      OptionalEmailSuppressionReason.ProviderSuppressed,
    ]) {
      const addressKey = deriveOptionalEmailAddressKey({
        address: `${reason}@example.test`,
        secret: fixtureSecret,
        version: OptionalEmailAddressKeyVersion.V1,
      });
      const at = new Date("2026-09-12T13:00:00.000Z");

      await repository.suppress({ addressKey, reason, at });

      const stored = await ctx.dbAccessor
        .getCollection<OptionalEmailAddressSuppression>(
          MongoDbDatabase.Auth,
          AuthDbCollection.OptionalEmailAddressSuppressions,
        )
        .findOne(addressKey);
      assert.equal(stored?.suppressedAt?.toISOString(), at.toISOString());
      assert.equal(stored?.suppressionReason, reason);
      assert.equal(
        await repository.findBlockReason({ addressKeys: [addressKey] }),
        OptionalEmailBlockReason.Suppressed,
      );
    }
  });

  it("fails closed for malformed matching tombstones", async () => {
    const at = new Date("2026-09-12T13:15:00.000Z");
    const malformedCases = [
      { name: "missing-block-marker", fields: {} },
      { name: "missing-suppression-reason", fields: { suppressedAt: at } },
      {
        name: "missing-suppressed-at",
        fields: { suppressionReason: OptionalEmailSuppressionReason.Complaint },
      },
    ] satisfies ReadonlyArray<{
      name: string;
      fields: Partial<Pick<OptionalEmailAddressSuppression, "suppressedAt" | "suppressionReason">>;
    }>;
    const collection = ctx.dbAccessor.getCollection<OptionalEmailAddressSuppression>(
      MongoDbDatabase.Auth,
      AuthDbCollection.OptionalEmailAddressSuppressions,
    );
    const addressKeys = malformedCases.map(({ name }) =>
      deriveOptionalEmailAddressKey({
        address: `${name}@example.test`,
        secret: fixtureSecret,
        version: OptionalEmailAddressKeyVersion.V1,
      }),
    );
    await collection.insertMany(
      malformedCases.map(({ fields }, index) => ({
        _id: new ObjectId(),
        ...addressKeys[index],
        ...fields,
        createdAt: at,
        updatedAt: at,
      })),
    );

    const results = await Promise.allSettled(
      addressKeys.map((addressKey) => repository.findBlockReason({ addressKeys: [addressKey] })),
    );

    for (const [index, result] of results.entries()) {
      assert.equal(result.status, "rejected", malformedCases[index]?.name);
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof InternalServerError, malformedCases[index]?.name);
      }
    }
  });

  it("rejects multiple keys for one version so secret rotation cannot silently reuse a version", async () => {
    const first = deriveOptionalEmailAddressKey({
      address: "shared@example.test",
      secret: fixtureSecret,
      version: OptionalEmailAddressKeyVersion.V1,
    });
    const second = deriveOptionalEmailAddressKey({
      address: "shared@example.test",
      secret: "z".repeat(32),
      version: OptionalEmailAddressKeyVersion.V1,
    });

    await assert.rejects(() => repository.findBlockReason({ addressKeys: [first, second] }), /internal_server_error/);
  });

  it("rejects an empty retained-version lookup instead of clearing suppression", async () => {
    await assert.rejects(() => repository.findBlockReason({ addressKeys: [] }), /internal_server_error/);
  });

  it("rejects a non-HMAC key before any raw address can be retained", async () => {
    const rawAddress = "raw@example.test";

    await assert.rejects(
      () =>
        repository.unsubscribe({
          addressKey: {
            addressKeyVersion: OptionalEmailAddressKeyVersion.V1,
            addressKey: rawAddress,
          },
          at: new Date("2026-09-12T13:30:00.000Z"),
        }),
      /internal_server_error/,
    );

    const retained = await ctx.dbAccessor
      .getCollection<OptionalEmailAddressSuppression>(
        MongoDbDatabase.Auth,
        AuthDbCollection.OptionalEmailAddressSuppressions,
      )
      .countDocuments({ addressKey: rawAddress });
    assert.equal(retained, 0);
  });

  it("rejects an unsupported suppression reason", async () => {
    const addressKey = deriveOptionalEmailAddressKey({
      address: "invalid-reason@example.test",
      secret: fixtureSecret,
      version: OptionalEmailAddressKeyVersion.V1,
    });

    await assert.rejects(
      () =>
        repository.suppress({
          addressKey,
          reason: "soft_bounce" as OptionalEmailSuppressionReason,
          at: new Date("2026-09-12T13:45:00.000Z"),
        }),
      /internal_server_error/,
    );
  });

  it("rejects an invalid event timestamp", async () => {
    const addressKey = deriveOptionalEmailAddressKey({
      address: "invalid-date@example.test",
      secret: fixtureSecret,
      version: OptionalEmailAddressKeyVersion.V1,
    });

    await assert.rejects(
      () => repository.unsubscribe({ addressKey, at: new Date("invalid") }),
      /internal_server_error/,
    );
  });

  it("rejects a non-Date event timestamp at the repository boundary", async () => {
    const addressKey = deriveOptionalEmailAddressKey({
      address: "missing-date@example.test",
      secret: fixtureSecret,
      version: OptionalEmailAddressKeyVersion.V1,
    });

    await assert.rejects(
      () => repository.unsubscribe({ addressKey, at: undefined as unknown as Date }),
      /internal_server_error/,
    );
  });

  it("replays a losing update after a concurrent tombstone creation", async () => {
    const addressKey = deriveOptionalEmailAddressKey({
      address: "race@example.test",
      secret: fixtureSecret,
      version: OptionalEmailAddressKeyVersion.V1,
    });
    const at = new Date("2026-09-12T14:00:00.000Z");
    const duplicateKeyError = new MongoServerError({ ok: 0, code: 11000, errmsg: "duplicate tombstone" });
    const winner: OptionalEmailAddressSuppression = {
      _id: new ObjectId(),
      ...addressKey,
      unsubscribedAt: at,
      createdAt: at,
      updatedAt: at,
    };
    let updateAttempts = 0;
    const racingRepository = new OptionalEmailAddressSuppressionRepository({
      getCollection: () => ({
        findOneAndUpdate: async (_filter: unknown, _update: unknown, options: { upsert: boolean }) => {
          updateAttempts += 1;
          if (updateAttempts === 1) {
            throw duplicateKeyError;
          }

          assert.equal(options.upsert, false);
          return {
            ...winner,
            suppressedAt: at,
            suppressionReason: OptionalEmailSuppressionReason.Complaint,
          };
        },
        findOne: async () => winner,
      }),
    } as unknown as MongoDbAccessor);

    const record = await racingRepository.suppress({
      addressKey,
      reason: OptionalEmailSuppressionReason.Complaint,
      at,
    });

    assert.equal(updateAttempts, 2);
    assert.equal(record.unsubscribedAt?.toISOString(), at.toISOString());
    assert.equal(record.suppressionReason, OptionalEmailSuppressionReason.Complaint);
  });
});

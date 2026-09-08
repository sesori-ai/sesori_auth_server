import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ObjectId, type Document } from "mongodb";
import type { OAuthAccount, PasswordAccount } from "../../src/models/documents.js";
import { OptionalEmailRecipientRepository } from "../../src/repositories/optional-email-recipient-repo.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("OptionalEmailRecipientRepository", () => {
  let ctx: TestContext;
  let repository: OptionalEmailRecipientRepository;

  before(async () => {
    ctx = await createTestApp();
    repository = new OptionalEmailRecipientRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("resolves a valid stored OAuth email without a provider allowlist", async () => {
    const user = await ctx.createUser({ provider: "future-provider" });
    const userId = new ObjectId(user.userId);
    await ctx.dbAccessor
      .getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts)
      .updateOne({ userId }, { $set: { email: " Person@Example.test " } });

    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: "resolved",
      address: "person@example.test",
      provenance: [{ accountKind: "oauth", provider: "future-provider", field: "email" }],
    });
  });

  it("returns typed missing when the user id is invalid or no linked identity stores an address", async () => {
    assert.deepEqual(await repository.resolve({ userId: "not-an-object-id" }), {
      status: "missing_recipient",
    });

    const user = await ctx.createUser();
    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: "missing_recipient",
    });
  });

  it("uses the validated legacy Apple address field without treating it as verified", async () => {
    const user = await ctx.createUser({ provider: "apple" });
    const userId = new ObjectId(user.userId);
    await ctx.dbAccessor
      .getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts)
      .updateOne({ userId }, { $set: { providerUsername: "Legacy@Example.test" }, $unset: { email: "" } });

    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: "resolved",
      address: "legacy@example.test",
      provenance: [
        {
          accountKind: "oauth",
          provider: "apple",
          field: "legacy_apple_provider_username",
        },
      ],
    });
  });

  it("retains both Apple field provenances when the current and legacy values agree", async () => {
    const user = await ctx.createUser({ provider: "apple" });
    await ctx.dbAccessor.getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts).updateOne(
      { userId: new ObjectId(user.userId) },
      {
        $set: {
          email: "same@example.test",
          providerUsername: "Same@Example.test",
        },
      },
    );

    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: "resolved",
      address: "same@example.test",
      provenance: [
        { accountKind: "oauth", provider: "apple", field: "email" },
        {
          accountKind: "oauth",
          provider: "apple",
          field: "legacy_apple_provider_username",
        },
      ],
    });
  });

  it("ignores non-Apple usernames and an absent Apple legacy field", async () => {
    const other = await ctx.createUser({ provider: "future-provider" });
    const apple = await ctx.createUser({ provider: "apple" });
    const oauthAccounts = ctx.dbAccessor.getCollection<OAuthAccount>(
      MongoDbDatabase.Auth,
      AuthDbCollection.OAuthAccounts,
    );
    await oauthAccounts.updateOne(
      { userId: new ObjectId(other.userId) },
      { $set: { providerUsername: "not-a-contact@example.test" }, $unset: { email: "" } },
    );
    await oauthAccounts.updateOne(
      { userId: new ObjectId(apple.userId) },
      { $unset: { providerUsername: "", email: "" } },
    );

    assert.deepEqual(await repository.resolve({ userId: other.userId }), {
      status: "missing_recipient",
    });
    assert.deepEqual(await repository.resolve({ userId: apple.userId }), {
      status: "missing_recipient",
    });
  });

  it("resolves a password-only address with its actual persisted provenance", async () => {
    const user = await ctx.createUser();
    const userId = new ObjectId(user.userId);
    const oauthAccounts = ctx.dbAccessor.getCollection<OAuthAccount>(
      MongoDbDatabase.Auth,
      AuthDbCollection.OAuthAccounts,
    );
    await oauthAccounts.updateOne({ userId }, { $unset: { email: "" } });
    await ctx.dbAccessor
      .getCollection<PasswordAccount>(MongoDbDatabase.Auth, AuthDbCollection.PasswordAccounts)
      .insertOne({
        _id: new ObjectId(),
        userId,
        email: "password@example.test",
        passwordHash: "fixture-only-hash",
        createdAt: new Date(3),
        updatedAt: new Date(3),
      });

    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: "resolved",
      address: "password@example.test",
      provenance: [{ accountKind: "password", provider: "email", field: "email" }],
    });
  });

  it("fails closed for conflicting valid addresses or any populated malformed address field", async () => {
    const conflicting = await ctx.createUser({ provider: "github" });
    const conflictingId = new ObjectId(conflicting.userId);
    const oauthAccounts = ctx.dbAccessor.getCollection<OAuthAccount>(
      MongoDbDatabase.Auth,
      AuthDbCollection.OAuthAccounts,
    );
    await oauthAccounts.updateOne({ userId: conflictingId }, { $set: { email: "one@example.test" } });
    await ctx.dbAccessor
      .getCollection<PasswordAccount>(MongoDbDatabase.Auth, AuthDbCollection.PasswordAccounts)
      .insertOne({
        _id: new ObjectId(),
        userId: conflictingId,
        email: "two@example.test",
        passwordHash: "fixture-only-hash",
        createdAt: new Date(4),
        updatedAt: new Date(4),
      });

    const malformed = await ctx.createUser({ provider: "future-provider" });
    await oauthAccounts.updateOne(
      { userId: new ObjectId(malformed.userId) },
      { $set: { email: "not-an-email-address" } },
    );

    assert.deepEqual(await repository.resolve({ userId: conflicting.userId }), {
      status: "ambiguous_recipient",
    });
    assert.deepEqual(await repository.resolve({ userId: malformed.userId }), {
      status: "ambiguous_recipient",
    });
  });

  it("treats disagreeing current and legacy Apple address fields as ambiguous", async () => {
    const user = await ctx.createUser({ provider: "apple" });
    await ctx.dbAccessor.getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts).updateOne(
      { userId: new ObjectId(user.userId) },
      {
        $set: {
          email: "current@example.test",
          providerUsername: "legacy@example.test",
        },
      },
    );

    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: "ambiguous_recipient",
    });
  });

  it("retains every linked source in deterministic order when all identities resolve to one address", async () => {
    const user = await ctx.createUser({ provider: "alpha-provider" });
    const userId = new ObjectId(user.userId);
    const oauthAccounts = ctx.dbAccessor.getCollection<OAuthAccount>(
      MongoDbDatabase.Auth,
      AuthDbCollection.OAuthAccounts,
    );
    await oauthAccounts.updateOne({ userId }, { $set: { email: "Same@Example.test" } });
    await oauthAccounts.insertOne({
      _id: new ObjectId(),
      userId,
      provider: "Zeta-provider",
      providerUserId: new ObjectId().toHexString(),
      providerUsername: "Display Name",
      email: "same@example.test",
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });
    await ctx.dbAccessor
      .getCollection<PasswordAccount>(MongoDbDatabase.Auth, AuthDbCollection.PasswordAccounts)
      .insertOne({
        _id: new ObjectId(),
        userId,
        email: "same@example.test",
        passwordHash: "fixture-only-hash",
        createdAt: new Date(2),
        updatedAt: new Date(2),
      });

    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: "resolved",
      address: "same@example.test",
      provenance: [
        { accountKind: "oauth", provider: "Zeta-provider", field: "email" },
        { accountKind: "oauth", provider: "alpha-provider", field: "email" },
        { accountKind: "password", provider: "email", field: "email" },
      ],
    });
  });

  it("fails closed when OAuth provenance is missing, blank, or non-string", async () => {
    const missing = await ctx.createUser({ provider: "future-provider" });
    const blank = await ctx.createUser({ provider: "future-provider" });
    const malformed = await ctx.createUser({ provider: "future-provider" });
    const accounts = ctx.dbAccessor.getCollection<Document>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts);
    await accounts.updateOne(
      { userId: new ObjectId(missing.userId) },
      { $set: { email: "valid@example.test" }, $unset: { provider: "" } },
    );
    await accounts.updateOne(
      { userId: new ObjectId(blank.userId) },
      { $set: { email: "valid@example.test", provider: "   " } },
    );
    await accounts.updateOne(
      { userId: new ObjectId(malformed.userId) },
      { $set: { email: "valid@example.test", provider: 42 } },
    );

    assert.deepEqual(await repository.resolve({ userId: missing.userId }), {
      status: "ambiguous_recipient",
    });
    assert.deepEqual(await repository.resolve({ userId: blank.userId }), {
      status: "ambiguous_recipient",
    });
    assert.deepEqual(await repository.resolve({ userId: malformed.userId }), {
      status: "ambiguous_recipient",
    });
  });

  it("fails closed for duplicate password identities", async () => {
    const user = await ctx.createUser();
    const userId = new ObjectId(user.userId);
    const accounts = ctx.dbAccessor.getCollection<PasswordAccount>(
      MongoDbDatabase.Auth,
      AuthDbCollection.PasswordAccounts,
    );
    await accounts.dropIndex("userId_1");
    try {
      await accounts.insertMany([
        {
          _id: new ObjectId(),
          userId,
          email: "first@example.test",
          passwordHash: "fixture-only-hash",
          createdAt: new Date(1),
          updatedAt: new Date(1),
        },
        {
          _id: new ObjectId(),
          userId,
          email: "FIRST@example.test",
          passwordHash: "fixture-only-hash",
          createdAt: new Date(2),
          updatedAt: new Date(2),
        },
      ]);

      assert.deepEqual(await repository.resolve({ userId: user.userId }), {
        status: "ambiguous_recipient",
      });
    } finally {
      await accounts.deleteMany({ userId });
      await accounts.createIndex({ userId: 1 }, { unique: true });
    }
  });
});

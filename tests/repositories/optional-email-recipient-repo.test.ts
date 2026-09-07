import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ObjectId } from "mongodb";
import type { OAuthAccount, PasswordAccount } from "../../src/models/documents.js";
import { OptionalEmailRecipientRepository } from "../../src/repositories/optional-email-recipient-repo.js";
import { OptionalEmailRecipientStatus } from "../../src/types/optional-email.js";
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

  it("requires an existing user and exactly one normalized address across account identities", async () => {
    assert.deepEqual(await repository.resolve({ userId: "not-an-object-id" }), {
      status: OptionalEmailRecipientStatus.MissingUser,
    });
    assert.deepEqual(await repository.resolve({ userId: new ObjectId().toHexString() }), {
      status: OptionalEmailRecipientStatus.MissingUser,
    });

    const user = await ctx.createUser();
    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: OptionalEmailRecipientStatus.MissingRecipient,
    });

    await ctx.dbAccessor
      .getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts)
      .updateOne({ userId: new ObjectId(user.userId) }, { $set: { email: " One@Example.Test " } });

    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: OptionalEmailRecipientStatus.Unique,
      email: "one@example.test",
    });

    const passwordAccounts = ctx.dbAccessor.getCollection<PasswordAccount>(
      MongoDbDatabase.Auth,
      AuthDbCollection.PasswordAccounts,
    );
    await passwordAccounts.insertOne({
      _id: new ObjectId(),
      userId: new ObjectId(user.userId),
      email: "one@example.test",
      passwordHash: "test-only-hash",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: OptionalEmailRecipientStatus.Unique,
      email: "one@example.test",
    });

    await passwordAccounts.updateOne(
      { userId: new ObjectId(user.userId) },
      { $set: { email: "different@example.test" } },
    );
    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: OptionalEmailRecipientStatus.AmbiguousRecipient,
    });

    await passwordAccounts.updateOne({ userId: new ObjectId(user.userId) }, { $set: { email: "not-an-email" } });
    assert.deepEqual(await repository.resolve({ userId: user.userId }), {
      status: OptionalEmailRecipientStatus.AmbiguousRecipient,
    });
  });
});

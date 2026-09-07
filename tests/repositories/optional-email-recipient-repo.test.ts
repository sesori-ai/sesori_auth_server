import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ObjectId } from "mongodb";
import type { OAuthAccount, PasswordAccount } from "../../src/models/documents.js";
import { OptionalEmailRecipientRepository } from "../../src/repositories/optional-email-recipient-repo.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("OptionalEmailRecipientRepository", () => {
  let ctx: TestContext;
  let repo: OptionalEmailRecipientRepository;

  before(async () => {
    ctx = await createTestApp();
    repo = new OptionalEmailRecipientRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("requires an existing user and exactly one normalized account email", async () => {
    assert.deepEqual(await repo.resolve({ userId: new ObjectId().toHexString() }), { status: "missing_user" });

    const user = await ctx.createUser();
    assert.deepEqual(await repo.resolve({ userId: user.userId }), { status: "missing_recipient" });

    const userObjectId = new ObjectId(user.userId);
    const oauth = ctx.dbAccessor.getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts);
    await oauth.updateOne({ userId: userObjectId }, { $set: { email: "One@Example.test" } });
    assert.deepEqual(await repo.resolve({ userId: user.userId }), {
      status: "unique",
      email: "one@example.test",
    });

    const password = ctx.dbAccessor.getCollection<PasswordAccount>(
      MongoDbDatabase.Auth,
      AuthDbCollection.PasswordAccounts,
    );
    await password.insertOne({
      _id: new ObjectId(),
      userId: userObjectId,
      email: "one@example.test",
      passwordHash: "test-only-hash",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    assert.deepEqual(await repo.resolve({ userId: user.userId }), {
      status: "unique",
      email: "one@example.test",
    });

    await password.updateOne({ userId: userObjectId }, { $set: { email: "different@example.test" } });
    assert.deepEqual(await repo.resolve({ userId: user.userId }), { status: "ambiguous_recipient" });
  });
});

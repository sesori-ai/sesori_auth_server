import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { MongoDbDatabase, AuthDbCollection } from "../../src/types/mongo.js";
import type { OAuthAccount } from "../../src/models/documents.js";
import { OAuthAccountRepository } from "../../src/repositories/oauth-account-repo.js";

describe("OAuthAccountRepository.upsert", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("preserves providerUsername on re-auth when Apple omits email", async () => {
    const collection = ctx.dbAccessor.getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts);

    const userId = new ObjectId();
    await collection.insertOne({
      _id: new ObjectId(),
      userId,
      provider: "apple",
      providerUserId: "apple-user-123",
      providerUsername: "alice@example.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const repo = new OAuthAccountRepository(ctx.dbAccessor);

    const afterNullUpsert = await repo.upsert({
      provider: "apple",
      providerUserId: "apple-user-123",
      providerUsername: null,
      email: null,
    });
    assert.equal(afterNullUpsert.account.providerUsername, "alice@example.com");

    const afterNewEmailUpsert = await repo.upsert({
      provider: "apple",
      providerUserId: "apple-user-123",
      providerUsername: "alice2@example.com",
      email: "alice2@example.com",
    });
    assert.equal(afterNewEmailUpsert.account.providerUsername, "alice2@example.com");
  });
});

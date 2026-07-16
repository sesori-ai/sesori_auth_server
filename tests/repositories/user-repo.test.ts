import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { InternalServerError } from "../../src/lib/errors.js";
import type { User } from "../../src/models/documents.js";
import { UserRepository } from "../../src/repositories/user-repo.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("UserRepository pagination", () => {
  let ctx: TestContext;
  let repo: UserRepository;

  before(async () => {
    ctx = await createTestApp();
    repo = new UserRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("iterates user ids in stable bounded batches", async () => {
    const userIds = ["000000000000000000000003", "000000000000000000000001", "000000000000000000000002"];
    for (const userId of userIds) {
      await repo.create(userId);
    }
    const createdAtOrBefore = new Date("2030-01-01T00:00:00.000Z");
    const laterUser = await repo.create("000000000000000000000004");
    await ctx.dbAccessor
      .getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users)
      .updateOne({ _id: laterUser._id }, { $set: { createdAt: new Date("2030-01-01T00:00:00.001Z") } });

    const first = await repo.findIdBatch(null, 2, createdAtOrBefore);
    const second = await repo.findIdBatch(first[1], 2, createdAtOrBefore);
    const exhausted = await repo.findIdBatch(second[0], 2, createdAtOrBefore);

    assert.deepEqual(first, ["000000000000000000000001", "000000000000000000000002"]);
    assert.deepEqual(second, ["000000000000000000000003"]);
    assert.deepEqual(exhausted, []);
  });

  it("rejects invalid limits and cursors", async () => {
    await assert.rejects(
      () => repo.findIdBatch(null, 0, new Date()),
      (error: unknown) => error instanceof InternalServerError && error.debugMessage === "Invalid user batch limit",
    );
    await assert.rejects(
      () => repo.findIdBatch("invalid", 1, new Date()),
      (error: unknown) =>
        error instanceof InternalServerError && error.debugMessage === "Invalid user pagination cursor",
    );
    await assert.rejects(
      () => repo.findIdBatch(null, 1, new Date("invalid")),
      (error: unknown) => error instanceof InternalServerError && error.debugMessage === "Invalid user creation cutoff",
    );
  });
});

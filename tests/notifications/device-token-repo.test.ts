import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DeviceTokenRepository } from "../../src/repositories/device-token-repo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("DeviceTokenRepository", () => {
  let ctx: TestContext;
  let repo: DeviceTokenRepository;

  before(async () => {
    ctx = await createTestApp();
    repo = new DeviceTokenRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("upsertToken creates new token", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-create", "ios");

    const tokens = await repo.findByUserId(user.userId);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]?.token, "token-create");
    assert.equal(tokens[0]?.platform, "ios");
  });

  it("upsertToken with same token updates timestamp (idempotent)", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-idempotent", "ios");
    const first = await repo.findByUserId(user.userId);
    const firstUpdatedAt = first[0]?.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await repo.upsertToken(user.userId, "token-idempotent", "android");

    const second = await repo.findByUserId(user.userId);
    assert.equal(second.length, 1);
    assert.equal(second[0]?.platform, "android");
    assert.ok(firstUpdatedAt instanceof Date);
    assert.ok(second[0]?.updatedAt instanceof Date);
    assert.ok((second[0]?.updatedAt.getTime() ?? 0) >= firstUpdatedAt.getTime());
  });

  it("findByUserId returns all tokens for user", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-list-1", "ios");
    await repo.upsertToken(user.userId, "token-list-2", "android");

    const tokens = await repo.findByUserId(user.userId);
    assert.equal(tokens.length, 2);
    assert.deepEqual(new Set(tokens.map((token) => token.token)), new Set(["token-list-1", "token-list-2"]));
  });

  it("deleteByToken removes specific token", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-delete-one", "ios");
    await repo.deleteByToken("token-delete-one");

    const tokens = await repo.findByUserId(user.userId);
    assert.equal(tokens.length, 0);
  });

  it("deleteByTokens removes provided tokens", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-delete-many-1", "ios");
    await repo.upsertToken(user.userId, "token-delete-many-2", "android");
    await repo.upsertToken(user.userId, "token-delete-many-3", "ios");

    await repo.deleteByTokens(["token-delete-many-1", "token-delete-many-2"]);

    const tokens = await repo.findByUserId(user.userId);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]?.token, "token-delete-many-3");
  });

  it("deleteAllForUser removes all tokens for user", async () => {
    const user = await ctx.createUser();

    await repo.upsertToken(user.userId, "token-delete-all-1", "ios");
    await repo.upsertToken(user.userId, "token-delete-all-2", "android");

    await repo.deleteAllForUser(user.userId);

    const tokens = await repo.findByUserId(user.userId);
    assert.equal(tokens.length, 0);
  });
});

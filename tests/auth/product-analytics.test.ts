import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ObjectId } from "mongodb";
import type { User } from "../../src/models/documents.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { ProductAnalyticsPreference } from "../../src/types/product-analytics.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("Product analytics preference routes", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("requires authentication for reads and updates", async () => {
    const getResponse = await ctx.app.inject({ method: "GET", url: "/product-analytics/preference" });
    const putResponse = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: 1,
        operationId: "11111111-1111-4111-8111-111111111111",
      }),
    });

    assert.equal(getResponse.statusCode, 401);
    assert.equal(putResponse.statusCode, 401);
  });

  it("returns the versioned preference without changing auth profile contracts", async () => {
    const user = await ctx.createUser();
    const response = await ctx.app.inject({
      method: "GET",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { preference: ProductAnalyticsPreference.Enabled, revision: 1 });
  });

  it("uses honest migration defaults for a legacy user", async () => {
    const userId = new ObjectId();
    const createdAt = new Date("2026-06-10T10:00:00.000Z");
    await ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users).insertOne({
      _id: userId,
      tokenVersion: 0,
      createdAt,
      updatedAt: createdAt,
    });
    const accessToken = ctx.tokenService.signAccessToken({
      userId: userId.toHexString(),
      provider: "github",
      providerUserId: "legacy-provider-user",
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { preference: ProductAnalyticsPreference.Enabled, revision: 1 });
  });

  it("updates by revision, replays a duplicate operation, and returns stale conflicts", async () => {
    const user = await ctx.createUser();
    const operationId = "22222222-2222-4222-8222-222222222222";
    const payload = {
      preference: ProductAnalyticsPreference.Disabled,
      expectedRevision: 1,
      operationId,
    };

    const first = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
    const duplicate = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
    const stale = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({
        preference: ProductAnalyticsPreference.Enabled,
        expectedRevision: 1,
        operationId: "33333333-3333-4333-8333-333333333333",
      }),
    });

    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { preference: ProductAnalyticsPreference.Disabled, revision: 2 });
    assert.equal(duplicate.statusCode, 200);
    assert.deepEqual(duplicate.json(), first.json());
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), {
      error: "conflict",
      preference: ProductAnalyticsPreference.Disabled,
      revision: 2,
    });
  });

  it("rejects malformed or extensible update bodies", async () => {
    const user = await ctx.createUser();
    const invalidBodies = [
      {},
      {
        preference: "unknown",
        expectedRevision: 1,
        operationId: "44444444-4444-4444-8444-444444444444",
      },
      {
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: 0,
        operationId: "44444444-4444-4444-8444-444444444444",
      },
      {
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: 1,
        operationId: "not-a-uuid",
      },
      {
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: 1,
        operationId: "44444444-4444-4444-8444-444444444444",
        userId: user.userId,
      },
    ];

    for (const body of invalidBodies) {
      const response = await ctx.app.inject({
        method: "PUT",
        url: "/product-analytics/preference",
        headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
        payload: JSON.stringify(body),
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "bad_request" });
    }
  });

  it("returns not found when the authenticated account no longer exists", async () => {
    const accessToken = ctx.tokenService.signAccessToken({
      userId: new ObjectId().toHexString(),
      provider: "github",
      providerUserId: "deleted-provider-user",
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "not_found" });
  });
});

import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { ObjectId } from "mongodb";
import type { Feedback } from "../../src/models/documents.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

const VALID_BODY = {
  issues: ["connection_drops", "app_slow"],
  message: "  The session list takes a while to load.  ",
  source: "settings",
  platform: "ios",
  appVersion: "1.6.0",
};

// The global limiter exempts loopback, and app.inject reports 127.0.0.1 by
// default, so rate-limit tests use their own routable address to engage the
// per-route limit.
let addressCounter = 0;
function nextClientAddress(): string {
  addressCounter += 1;
  return `198.51.100.${addressCounter}`;
}

describe("/feedback routes", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  function feedbackCollection() {
    return ctx.dbAccessor.getCollection<Feedback>(MongoDbDatabase.Auth, AuthDbCollection.Feedback);
  }

  function postFeedback(accessToken: string | null, body: unknown, remoteAddress?: string) {
    return ctx.app.inject({
      method: "POST",
      url: "/feedback",
      headers: {
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  }

  it("stores a submission for the authenticated user and responds 201", async () => {
    const user = await ctx.createUser();
    const before = new Date();

    const res = await postFeedback(user.accessToken, VALID_BODY);

    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), { ok: true });
    const documents = await feedbackCollection()
      .find({ userId: new ObjectId(user.userId) })
      .toArray();
    assert.equal(documents.length, 1);
    const [document] = documents;
    assert.deepEqual(document.issues, ["connection_drops", "app_slow"]);
    assert.equal(document.message, "The session list takes a while to load.");
    assert.equal(document.source, "settings");
    assert.equal(document.platform, "ios");
    assert.equal(document.appVersion, "1.6.0");
    assert.ok(document.createdAt >= before);
  });

  it("accepts an empty submission and stores no message field", async () => {
    const user = await ctx.createUser();

    const res = await postFeedback(user.accessToken, {
      issues: [],
      source: "automatic",
      platform: "android",
      appVersion: "1.6.0",
    });

    assert.equal(res.statusCode, 201);
    const document = await feedbackCollection().findOne({ userId: new ObjectId(user.userId) });
    assert.ok(document);
    assert.deepEqual(document.issues, []);
    assert.equal("message" in document, false);
    assert.equal(document.source, "automatic");
    assert.equal(document.platform, "android");
  });

  const invalidBodies: Array<[string, Record<string, unknown>]> = [
    ["an unknown issue", { ...VALID_BODY, issues: ["too_many_bugs"] }],
    ["duplicate issues", { ...VALID_BODY, issues: ["app_slow", "app_slow"] }],
    ["missing issues", { ...VALID_BODY, issues: undefined }],
    ["a message over 4000 characters", { ...VALID_BODY, message: "a".repeat(4001) }],
    ["a whitespace-only message", { ...VALID_BODY, message: "   " }],
    ["an unknown source", { ...VALID_BODY, source: "email" }],
    ["an unsupported platform", { ...VALID_BODY, platform: "macos" }],
    ["an empty appVersion", { ...VALID_BODY, appVersion: "" }],
    ["an appVersion over 32 characters", { ...VALID_BODY, appVersion: "1".repeat(33) }],
  ];

  for (const [description, body] of invalidBodies) {
    it(`rejects ${description} with 400 and stores nothing`, async () => {
      const user = await ctx.createUser();

      const res = await postFeedback(user.accessToken, body);

      assert.equal(res.statusCode, 400);
      assert.equal(await feedbackCollection().countDocuments({ userId: new ObjectId(user.userId) }), 0);
    });
  }

  it("accepts a message of exactly 4000 characters", async () => {
    const user = await ctx.createUser();

    const res = await postFeedback(user.accessToken, { ...VALID_BODY, message: "a".repeat(4000) });

    assert.equal(res.statusCode, 201);
  });

  it("never logs the message text of a rejected submission", async () => {
    const user = await ctx.createUser();
    const secret = `sk-live-${"x".repeat(4000)}`;
    const errorLog = mock.method(console, "error", () => {});

    try {
      const res = await postFeedback(user.accessToken, { ...VALID_BODY, message: secret });

      assert.equal(res.statusCode, 400);
      assert.ok(errorLog.mock.callCount() > 0, "the rejection is still logged");
      const logged = JSON.stringify(errorLog.mock.calls.map((call) => call.arguments));
      assert.equal(logged.includes("sk-live-"), false);
    } finally {
      errorLog.mock.restore();
    }
  });

  it("rejects an unauthenticated submission with 401", async () => {
    const res = await postFeedback(null, VALID_BODY);

    assert.equal(res.statusCode, 401);
  });

  it("limits each account to 10 submissions per hour without affecting other accounts", async () => {
    const user = await ctx.createUser();
    const other = await ctx.createUser();
    const clientAddress = nextClientAddress();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await postFeedback(user.accessToken, VALID_BODY, clientAddress)).statusCode);
    }

    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
    assert.equal(statuses[10], 429);
    assert.equal(await feedbackCollection().countDocuments({ userId: new ObjectId(user.userId) }), 10);
    assert.equal((await postFeedback(other.accessToken, VALID_BODY, clientAddress)).statusCode, 201);
  });
});

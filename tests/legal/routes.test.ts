import assert from "node:assert/strict";
import type { TestContext as NodeTestContext } from "node:test";
import { describe, it } from "node:test";
import { MongoClient } from "mongodb";
import { MongoDbAccessor } from "../../src/db/mongo-db-accessor.js";
import { MongoDbConnector } from "../../src/db/mongo-db-connector.js";
import { LegalDocumentService } from "../../src/services/legal-document-service.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("Legal routes", () => {
  function mockMongoHarness(t: { mock: NodeTestContext["mock"] }) {
    const fakeCollection = {} as never;
    const fakeDb = {
      collection: () => fakeCollection,
      dropDatabase: async () => {},
    } as never;

    t.mock.method(MongoClient.prototype, "connect", async function () {
      return this;
    });
    t.mock.method(MongoClient.prototype, "close", async () => {});
    t.mock.method(MongoDbConnector.prototype, "getDb", () => fakeDb);
    t.mock.method(MongoDbAccessor.prototype, "ensureIndexes", async () => {});
  }

  async function createRouteTestApp(t: NodeTestContext): Promise<TestContext> {
    mockMongoHarness(t);
    return createTestApp({
      legalDocumentService: new LegalDocumentService("# Terms\n\nTerms body\n", "# Privacy\n\nPrivacy body\n"),
    });
  }

  it("GET /terms returns the terms document as plain text without auth", async (t) => {
    const ctx = await createRouteTestApp(t);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/terms",
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"] ?? "", /text\/plain/);
      assert.equal(res.body, "# Terms\n\nTerms body\n");
    } finally {
      await ctx.cleanup();
    }
  });

  it("GET /privacy returns the privacy document as plain text without auth", async (t) => {
    const ctx = await createRouteTestApp(t);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/privacy",
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"] ?? "", /text\/plain/);
      assert.equal(res.body, "# Privacy\n\nPrivacy body\n");
    } finally {
      await ctx.cleanup();
    }
  });

  it("POST /terms remains unregistered", async (t) => {
    const ctx = await createRouteTestApp(t);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/terms",
      });

      assert.equal(res.statusCode, 404);
    } finally {
      await ctx.cleanup();
    }
  });

  it("POST /privacy remains unregistered", async (t) => {
    const ctx = await createRouteTestApp(t);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/privacy",
      });

      assert.equal(res.statusCode, 404);
    } finally {
      await ctx.cleanup();
    }
  });
});

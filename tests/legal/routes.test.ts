import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { TestContext as NodeTestContext } from "node:test";
import { describe, it } from "node:test";
import { MongoClient } from "mongodb";
import { getLegalDocumentUrl } from "../../src/lib/legal-document-paths.js";
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
      legalDocumentService: new LegalDocumentService("# Terms\n\nTerms body\n", "# Privacy\n\nПоверителност body\n"),
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
      assert.match(res.headers["content-type"] ?? "", /^text\/plain;\s*charset=utf-8\b/i);
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
      assert.match(res.headers["content-type"] ?? "", /^text\/plain;\s*charset=utf-8\b/i);
      assert.equal(res.body, "# Privacy\n\nПоверителност body\n");
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

  it("serves the real privacy asset disclosing every AI sub-processor", async (t) => {
    // The other route tests inject synthetic text, so nothing else proves the
    // shipped asset actually discloses the providers we send audio to.
    mockMongoHarness(t);
    const compositionRootUrl = new URL("../../src/index.ts", import.meta.url).href;
    const [termsText, privacyText] = await Promise.all([
      readFile(getLegalDocumentUrl(compositionRootUrl, "terms"), "utf8"),
      readFile(getLegalDocumentUrl(compositionRootUrl, "privacy"), "utf8"),
    ]);
    const ctx = await createTestApp({
      legalDocumentService: new LegalDocumentService(termsText, privacyText),
    });

    try {
      const res = await ctx.app.inject({ method: "GET", url: "/privacy" });

      assert.equal(res.statusCode, 200);
      for (const subProcessor of ["OpenAI", "Soniox", "Anthropic"]) {
        assert.ok(res.body.includes(subProcessor), `privacy policy must disclose ${subProcessor}`);
      }
      assert.ok(res.body.includes("United States (US regional project)"));
      assert.ok(
        res.body.includes("audio is processed and temporarily stored in Soniox's United States regional project"),
      );
    } finally {
      await ctx.cleanup();
    }
  });
});

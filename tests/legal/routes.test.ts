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
      legalDocumentService: new LegalDocumentService({
        termsText: "# Terms\n\nTerms body\n",
        privacyText: "# Privacy\n\nПоверителност body\n",
        cookiesText: "# Cookies\n\nCookie body\n",
      }),
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

  it("GET /cookies returns the Cookie Statement as plain text without auth", async (t) => {
    const ctx = await createRouteTestApp(t);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/cookies",
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"] ?? "", /^text\/plain;\s*charset=utf-8\b/i);
      assert.equal(res.body, "# Cookies\n\nCookie body\n");
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

  it("POST /cookies remains unregistered", async (t) => {
    const ctx = await createRouteTestApp(t);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/cookies",
      });

      assert.equal(res.statusCode, 404);
    } finally {
      await ctx.cleanup();
    }
  });

  it("serves the real legal assets with current service disclosures", async (t) => {
    // The other route tests inject synthetic text, so this is the contract for
    // every provider, advertising use, cookie, and legal cross-reference shipped in production.
    mockMongoHarness(t);
    const compositionRootUrl = new URL("../../src/index.ts", import.meta.url).href;
    const [termsText, privacyText, cookiesText] = await Promise.all([
      readFile(getLegalDocumentUrl(compositionRootUrl, "terms"), "utf8"),
      readFile(getLegalDocumentUrl(compositionRootUrl, "privacy"), "utf8"),
      readFile(getLegalDocumentUrl(compositionRootUrl, "cookies"), "utf8"),
    ]);
    const ctx = await createTestApp({
      legalDocumentService: new LegalDocumentService({ termsText, privacyText, cookiesText }),
    });

    try {
      const [termsRes, privacyRes, cookiesRes] = await Promise.all([
        ctx.app.inject({ method: "GET", url: "/terms" }),
        ctx.app.inject({ method: "GET", url: "/privacy" }),
        ctx.app.inject({ method: "GET", url: "/cookies" }),
      ]);

      assert.equal(termsRes.statusCode, 200);
      assert.ok(termsRes.body.includes("Cookie Statement"));
      assert.ok(termsRes.body.includes("derived project glossary terms"));
      assert.ok(termsRes.body.includes("The raw repository origin"));
      assert.ok(termsRes.body.includes("not covered by the voice-recording and transcript deletion statement"));
      assert.ok(termsRes.body.includes("Account deletion purges all project glossary terms"));
      assert.ok(termsRes.body.includes("advertising audience matching"));

      assert.equal(privacyRes.statusCode, 200);
      for (const disclosure of [
        "OpenAI",
        "Soniox",
        "Anthropic",
        "Google Analytics 4",
        "Meta Pixel",
        "Singular Flutter SDK",
        "Meta Customer List Custom Audiences",
        "Lookalike Audience",
      ]) {
        assert.ok(privacyRes.body.includes(disclosure), `privacy policy must disclose ${disclosure}`);
      }
      assert.ok(privacyRes.body.includes("G-5R35L8J3NT"));
      assert.ok(privacyRes.body.includes("1619146889579169"));
      assert.ok(privacyRes.body.includes("cryptographically hash the email address"));
      assert.doesNotMatch(privacyRes.body, /currently does \*\*not\*\* use cookies or website analytics/i);
      assert.ok(privacyRes.body.includes("email address associated with your Sesori account"));
      assert.ok(privacyRes.body.includes("non-essential analytics and advertising tags remain disabled"));
      assert.ok(privacyRes.body.includes("Global Privacy Control"));
      assert.ok(
        privacyRes.body.includes("Official mobile release builds for which Sesori enables advertising attribution"),
      );
      assert.ok(privacyRes.body.includes("United States (US regional project)"));
      assert.ok(privacyRes.body.includes("bounded project glossary terms (keywords)"));
      assert.ok(privacyRes.body.includes("not sent to website analytics"));
      assert.ok(privacyRes.body.includes("Project glossary terms and associated scope metadata"));
      assert.ok(
        privacyRes.body.includes("All glossary terms and associated scope metadata belonging to an account are purged"),
      );
      assert.ok(privacyRes.body.includes("glossary context supplied with a voice request"));
      assert.ok(
        privacyRes.body.includes(
          "audio is processed and temporarily stored in Soniox's United States regional project",
        ),
      );

      assert.equal(cookiesRes.statusCode, 200);
      assert.ok(cookiesRes.body.includes("G-5R35L8J3NT"));
      assert.ok(cookiesRes.body.includes("1619146889579169"));
      for (const cookie of ["_ga", "_ga_*", "_fbp", "_fbc"]) {
        assert.ok(cookiesRes.body.includes(`\`${cookie}\``), `Cookie Statement must disclose ${cookie}`);
      }
      assert.ok(cookiesRes.body.includes("Global Privacy Control"));
      assert.ok(cookiesRes.body.includes("Meta Pixel and its `<noscript>` image fallback"));
      assert.ok(cookiesRes.body.includes("Google Analytics and Meta Pixel do not load until"));
    } finally {
      await ctx.cleanup();
    }
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("Glossary routes", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  describe("GET /voice/glossary", () => {
    it("returns empty array for a new user", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "GET",
        url: "/voice/glossary",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { words: [] });
    });

    it("returns 401 when called without authentication", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/voice/glossary",
      });

      assert.equal(res.statusCode, 401);
    });
  });

  describe("POST /voice/glossary", () => {
    it("adds words and returns them in the response", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "POST",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: ["Sesori", "HKDF", "XChaCha20"] }),
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ added: string[] }>();
      assert.equal(body.added.length, 3);
      assert.ok(body.added.includes("Sesori"));
      assert.ok(body.added.includes("HKDF"));
      assert.ok(body.added.includes("XChaCha20"));
    });

    it("skips duplicates and returns only newly added words", async () => {
      const user = await ctx.createUser();

      await ctx.app.inject({
        method: "POST",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: ["Alpha", "Beta"] }),
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: ["Beta", "Gamma"] }),
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ added: string[] }>();
      assert.equal(body.added.length, 1);
      assert.ok(body.added.includes("Gamma"));
    });

    it("returns 400 when words array is empty", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "POST",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: [] }),
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when body is missing words field", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "POST",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({}),
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 401 when called without authentication", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/voice/glossary",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ words: ["Test"] }),
      });

      assert.equal(res.statusCode, 401);
    });
  });

  describe("DELETE /voice/glossary", () => {
    it("removes existing words and returns the count", async () => {
      const user = await ctx.createUser();

      await ctx.app.inject({
        method: "POST",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: ["ToRemove1", "ToRemove2", "ToKeep"] }),
      });

      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: ["ToRemove1", "ToRemove2"] }),
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { removed: 2 });

      const listRes = await ctx.app.inject({
        method: "GET",
        url: "/voice/glossary",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      const remaining = listRes.json<{ words: string[] }>();
      assert.deepEqual(remaining.words, ["ToKeep"]);
    });

    it("returns 0 when removing words that do not exist", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: ["NonExistent"] }),
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { removed: 0 });
    });

    it("returns 400 when words array is empty", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: [] }),
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 401 when called without authentication", async () => {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/voice/glossary",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ words: ["Test"] }),
      });

      assert.equal(res.statusCode, 401);
    });
  });

  describe("glossary isolation between users", () => {
    it("each user has an independent glossary", async () => {
      const userA = await ctx.createUser();
      const userB = await ctx.createUser();

      await ctx.app.inject({
        method: "POST",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${userA.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: ["UserA_Word"] }),
      });

      await ctx.app.inject({
        method: "POST",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${userB.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: ["UserB_Word"] }),
      });

      const resA = await ctx.app.inject({
        method: "GET",
        url: "/voice/glossary",
        headers: { authorization: `Bearer ${userA.accessToken}` },
      });
      const resB = await ctx.app.inject({
        method: "GET",
        url: "/voice/glossary",
        headers: { authorization: `Bearer ${userB.accessToken}` },
      });

      assert.deepEqual(resA.json<{ words: string[] }>().words, ["UserA_Word"]);
      assert.deepEqual(resB.json<{ words: string[] }>().words, ["UserB_Word"]);
    });
  });

  describe("full CRUD flow", () => {
    it("add → list → remove → list works end-to-end", async () => {
      const user = await ctx.createUser();

      const addRes = await ctx.app.inject({
        method: "POST",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: ["Fastify", "MongoDB", "Zod"] }),
      });
      assert.equal(addRes.statusCode, 200);
      assert.equal(addRes.json<{ added: string[] }>().added.length, 3);

      const listRes = await ctx.app.inject({
        method: "GET",
        url: "/voice/glossary",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      assert.equal(listRes.statusCode, 200);
      const words = listRes.json<{ words: string[] }>().words;
      assert.equal(words.length, 3);
      assert.ok(words.includes("Fastify"));
      assert.ok(words.includes("MongoDB"));
      assert.ok(words.includes("Zod"));

      const deleteRes = await ctx.app.inject({
        method: "DELETE",
        url: "/voice/glossary",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ words: ["MongoDB"] }),
      });
      assert.equal(deleteRes.statusCode, 200);
      assert.deepEqual(deleteRes.json(), { removed: 1 });

      const finalListRes = await ctx.app.inject({
        method: "GET",
        url: "/voice/glossary",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      assert.equal(finalListRes.statusCode, 200);
      const remaining = finalListRes.json<{ words: string[] }>().words;
      assert.equal(remaining.length, 2);
      assert.ok(remaining.includes("Fastify"));
      assert.ok(remaining.includes("Zod"));
      assert.ok(!remaining.includes("MongoDB"));
    });
  });
});

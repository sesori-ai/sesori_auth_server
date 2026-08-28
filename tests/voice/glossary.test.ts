import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { ProjectGlossaryScopeType } from "../../src/models/voice.js";

const projectA = `prj_v1_${"A".repeat(43)}`;
const projectB = `prj_v1_${"B".repeat(43)}`;

describe("Glossary routes", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  async function addWords(accessToken: string, projectKey: string, words: string[]) {
    return ctx.app.inject({
      method: "POST",
      url: "/voice/glossary",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ scope: { type: ProjectGlossaryScopeType.repository, projectKey }, words }),
    });
  }

  async function listWords(accessToken: string, query: string) {
    return ctx.app.inject({
      method: "GET",
      url: `/voice/glossary${query}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  async function removeWords(accessToken: string, projectKey: string, words: string[]) {
    return ctx.app.inject({
      method: "DELETE",
      url: "/voice/glossary",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ projectKey, words }),
    });
  }

  describe("GET /voice/glossary", () => {
    it("returns an empty array for a valid project with no entries", async () => {
      const user = await ctx.createUser();

      const res = await listWords(user.accessToken, `?projectKey=${projectA}`);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { words: [] });
    });

    it("returns 400 when the project key is missing, malformed, or duplicated", async () => {
      const user = await ctx.createUser();

      for (const query of ["", "?projectKey=nope", `?projectKey=${projectA}&projectKey=${projectB}`, "?unknown=1"]) {
        const res = await listWords(user.accessToken, query);
        assert.equal(res.statusCode, 400, query);
      }
    });

    it("returns 401 when called without authentication", async () => {
      const res = await ctx.app.inject({ method: "GET", url: `/voice/glossary?projectKey=${projectA}` });

      assert.equal(res.statusCode, 401);
    });
  });

  describe("POST /voice/glossary", () => {
    it("adds words scoped to the requested project", async () => {
      const user = await ctx.createUser();

      const res = await addWords(user.accessToken, projectA, ["Sesori", "HKDF", "XChaCha20"]);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json<{ added: string[] }>().added.sort(), ["HKDF", "Sesori", "XChaCha20"]);
      assert.deepEqual((await listWords(user.accessToken, `?projectKey=${projectB}`)).json(), { words: [] });
    });

    it("normalizes surrounding whitespace and deduplicates within a request", async () => {
      const user = await ctx.createUser();

      const res = await addWords(user.accessToken, projectA, ["  Alpha  ", "Alpha", "Beta"]);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json<{ added: string[] }>().added.sort(), ["Alpha", "Beta"]);
    });

    it("skips duplicates already persisted in the same project", async () => {
      const user = await ctx.createUser();
      await addWords(user.accessToken, projectA, ["Alpha", "Beta"]);

      const res = await addWords(user.accessToken, projectA, ["Beta", "Gamma"]);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json<{ added: string[] }>().added, ["Gamma"]);
    });

    it("keeps the same word independent across projects", async () => {
      const user = await ctx.createUser();
      await addWords(user.accessToken, projectA, ["Shared"]);

      const res = await addWords(user.accessToken, projectB, ["Shared"]);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json<{ added: string[] }>().added, ["Shared"]);
      assert.deepEqual((await listWords(user.accessToken, `?projectKey=${projectB}`)).json(), { words: ["Shared"] });
    });

    it("returns 400 for invalid scope fields, empty words, and unknown fields", async () => {
      const user = await ctx.createUser();
      const invalidBodies = [
        { words: ["Test"] },
        { scope: { type: ProjectGlossaryScopeType.repository, projectKey: "prj_v1_short" }, words: ["Test"] },
        {
          scope: { type: ProjectGlossaryScopeType.bridgeLocal, projectKey: projectA },
          words: ["Test"],
        },
        {
          scope: { type: ProjectGlossaryScopeType.bridgeLocal, projectKey: projectA, bridgeId: "not-a-bridge" },
          words: ["Test"],
        },
        { scope: { type: ProjectGlossaryScopeType.repository, projectKey: projectA }, words: [] },
        { scope: { type: ProjectGlossaryScopeType.repository, projectKey: projectA }, words: ["   "] },
        {
          scope: { type: ProjectGlossaryScopeType.repository, projectKey: projectA },
          words: ["Test"],
          unexpected: true,
        },
        {
          scope: { type: ProjectGlossaryScopeType.repository, projectKey: projectA },
          words: [`${"x".repeat(201)}`],
        },
      ];

      for (const body of invalidBodies) {
        const res = await ctx.app.inject({
          method: "POST",
          url: "/voice/glossary",
          headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
          payload: JSON.stringify(body),
        });
        assert.equal(res.statusCode, 400, JSON.stringify(body));
      }
    });

    it("returns 401 when called without authentication", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/voice/glossary",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ projectKey: projectA, words: ["Test"] }),
      });

      assert.equal(res.statusCode, 401);
    });
  });

  describe("DELETE /voice/glossary", () => {
    it("removes only words in the requested project", async () => {
      const user = await ctx.createUser();
      await addWords(user.accessToken, projectA, ["ToRemove", "ToKeep"]);
      await addWords(user.accessToken, projectB, ["ToRemove"]);

      const res = await removeWords(user.accessToken, projectA, ["ToRemove"]);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { removed: 1 });
      assert.deepEqual((await listWords(user.accessToken, `?projectKey=${projectA}`)).json(), { words: ["ToKeep"] });
      assert.deepEqual((await listWords(user.accessToken, `?projectKey=${projectB}`)).json(), { words: ["ToRemove"] });
    });

    it("returns 0 when removing words that do not exist", async () => {
      const user = await ctx.createUser();

      const res = await removeWords(user.accessToken, projectA, ["NonExistent"]);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { removed: 0 });
    });

    it("returns 400 when the project key is missing", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/voice/glossary",
        headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
        payload: JSON.stringify({ words: ["Test"] }),
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 401 when called without authentication", async () => {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/voice/glossary",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ projectKey: projectA, words: ["Test"] }),
      });

      assert.equal(res.statusCode, 401);
    });
  });

  describe("isolation and full CRUD flow", () => {
    it("keeps the same project key independent per user", async () => {
      const userA = await ctx.createUser();
      const userB = await ctx.createUser();

      await addWords(userA.accessToken, projectA, ["UserA_Word"]);
      await addWords(userB.accessToken, projectA, ["UserB_Word"]);

      assert.deepEqual((await listWords(userA.accessToken, `?projectKey=${projectA}`)).json(), {
        words: ["UserA_Word"],
      });
      assert.deepEqual((await listWords(userB.accessToken, `?projectKey=${projectA}`)).json(), {
        words: ["UserB_Word"],
      });
    });

    it("add → list → remove → list works end-to-end", async () => {
      const user = await ctx.createUser();

      assert.equal((await addWords(user.accessToken, projectA, ["Fastify", "MongoDB", "Zod"])).statusCode, 200);
      assert.deepEqual((await listWords(user.accessToken, `?projectKey=${projectA}`)).json(), {
        words: ["Fastify", "MongoDB", "Zod"],
      });

      assert.deepEqual((await removeWords(user.accessToken, projectA, ["MongoDB"])).json(), { removed: 1 });
      assert.deepEqual((await listWords(user.accessToken, `?projectKey=${projectA}`)).json(), {
        words: ["Fastify", "Zod"],
      });
    });
  });
});

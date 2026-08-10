import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { GlossaryEntryRepository } from "../../src/repositories/glossary-entry-repo.js";
import { GlossaryService, glossaryPolicy } from "../../src/services/glossary-service.js";
import type { GlossaryEntry } from "../../src/models/documents.js";
import { projectKeySchema } from "../../src/models/voice.js";
import { BadRequestError } from "../../src/lib/errors.js";
import { MongoDbDatabase, AuthDbCollection } from "../../src/types/mongo.js";

const projectA = projectKeySchema.parse(`prj_v1_${"A".repeat(43)}`);
const projectB = projectKeySchema.parse(`prj_v1_${"B".repeat(43)}`);

function words(prefix: string, count: number, start = 0): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(start + index).padStart(5, "0")}`);
}

describe("GlossaryService", () => {
  let ctx: TestContext;
  let repo: GlossaryEntryRepository;
  let service: GlossaryService;
  let userId: string;

  before(async () => {
    ctx = await createTestApp();
    repo = new GlossaryEntryRepository(ctx.dbAccessor);
    service = new GlossaryService({ glossaryRepo: repo });
  });

  after(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    await ctx.dbAccessor
      .getCollection<GlossaryEntry>(MongoDbDatabase.Auth, AuthDbCollection.GlossaryEntries)
      .deleteMany({});
    userId = new ObjectId().toHexString();
  });

  it("deduplicates a request while preserving first occurrence order", async () => {
    const added = await service.addWords({ userId, projectKey: projectA, words: ["Beta", "Alpha", "Beta"] });

    assert.deepEqual(added, ["Beta", "Alpha"]);
  });

  it("truncates to the remaining per-project capacity", async () => {
    await repo.insertMany({ userId, projectKey: projectA, words: words("p", glossaryPolicy.maxWordsPerProject - 2) });

    const added = await service.addWords({ userId, projectKey: projectA, words: ["One", "Two", "Three"] });

    assert.deepEqual(added, ["One", "Two"]);
    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectA }), glossaryPolicy.maxWordsPerProject);
  });

  it("truncates to the remaining per-user capacity across projects", async () => {
    const perProject = glossaryPolicy.maxWordsPerProject;
    const projects = Array.from({ length: 9 }, (_, index) =>
      projectKeySchema.parse(`prj_v1_${String(index).repeat(43)}`),
    );
    for (const [index, projectKey] of projects.entries()) {
      await repo.insertMany({ userId, projectKey, words: words(`u${index}_`, perProject) });
    }
    await repo.insertMany({ userId, projectKey: projectA, words: words("tail_", 499) });

    const added = await service.addWords({ userId, projectKey: projectA, words: ["Last", "Overflow"] });

    assert.deepEqual(added, ["Last"]);
    assert.equal(await repo.countScopedByUserId(userId), glossaryPolicy.maxWordsPerUser);
  });

  it("adds nothing and never passes a negative limit when a cap is already exceeded", async () => {
    await repo.insertMany({
      userId,
      projectKey: projectA,
      words: words("over", glossaryPolicy.maxWordsPerProject + 5),
    });

    const added = await service.addWords({ userId, projectKey: projectA, words: ["Blocked"] });

    assert.deepEqual(added, []);
    assert.equal(
      await repo.countByUserAndProject({ userId, projectKey: projectA }),
      glossaryPolicy.maxWordsPerProject + 5,
    );
  });

  it("does not let an already-stored word consume the last free capacity slot", async () => {
    await repo.insertMany({
      userId,
      projectKey: projectA,
      words: [...words("w", glossaryPolicy.maxWordsPerProject - 2), "Dup"],
    });

    const added = await service.addWords({ userId, projectKey: projectA, words: ["Dup", "BrandNew"] });

    assert.deepEqual(added, ["BrandNew"]);
  });

  it("excludes unscoped legacy rows from the per-user capacity", async () => {
    await ctx.dbAccessor
      .getDb(MongoDbDatabase.Auth)
      .collection(AuthDbCollection.GlossaryEntries)
      .insertOne({ _id: new ObjectId(), userId: new ObjectId(userId), word: "Legacy", createdAt: new Date() });

    assert.equal(await repo.countScopedByUserId(userId), 0);
    assert.deepEqual(await service.addWords({ userId, projectKey: projectA, words: ["Scoped"] }), ["Scoped"]);
  });

  it("rejects an invalid request before performing any database work", async () => {
    let queried = false;
    const spyRepo = {
      findWordsByUserAndProject: async () => {
        queried = true;
        return [];
      },
      countByUserAndProject: async () => {
        queried = true;
        return 0;
      },
      countScopedByUserId: async () => {
        queried = true;
        return 0;
      },
      insertMany: async () => [],
      deleteMany: async () => 0,
    } as unknown as GlossaryEntryRepository;
    const spyService = new GlossaryService({ glossaryRepo: spyRepo });

    await assert.rejects(
      () =>
        spyService.addWords({
          userId,
          projectKey: projectA,
          words: words("x", glossaryPolicy.maxWordsPerRequest + 1),
        }),
      BadRequestError,
    );
    assert.equal(queried, false, "no query should run for a request that is guaranteed to be rejected");
  });

  it("enforces request and word-length caps for non-route callers", async () => {
    await assert.rejects(
      () =>
        service.addWords({ userId, projectKey: projectA, words: words("x", glossaryPolicy.maxWordsPerRequest + 1) }),
      BadRequestError,
    );
    await assert.rejects(
      () =>
        service.addWords({ userId, projectKey: projectA, words: ["y".repeat(glossaryPolicy.maxWordCharacters + 1)] }),
      BadRequestError,
    );
    await assert.rejects(() => service.addWords({ userId, projectKey: projectA, words: ["   "] }), BadRequestError);
    await assert.rejects(
      () =>
        service.removeWords({ userId, projectKey: projectA, words: words("z", glossaryPolicy.maxWordsPerRequest + 1) }),
      BadRequestError,
    );
  });

  it("keeps the rendered prompt within the context budget", async () => {
    const term = "x".repeat(glossaryPolicy.maxWordCharacters);
    await repo.insertMany({
      userId,
      projectKey: projectA,
      words: Array.from({ length: 90 }, (_, index) => `${String(index).padStart(3, "0")}${term}`),
    });

    const prompt = await service.buildTranscriptionPrompt({ userId, projectKey: projectA });

    assert.ok(prompt);
    assert.ok(
      prompt.length <= glossaryPolicy.maxContextCharacters,
      `rendered prompt ${prompt.length} exceeded ${glossaryPolicy.maxContextCharacters}`,
    );
  });

  it("builds no prompt without project context or terms", async () => {
    assert.equal(await service.buildTranscriptionPrompt({ userId, projectKey: null }), null);
    assert.equal(await service.buildTranscriptionPrompt({ userId, projectKey: projectA }), null);
  });

  it("lists and removes only within one project", async () => {
    await service.addWords({ userId, projectKey: projectA, words: ["Alpha", "Beta"] });
    await service.addWords({ userId, projectKey: projectB, words: ["Alpha"] });

    assert.deepEqual(await service.listWords({ userId, projectKey: projectA }), ["Alpha", "Beta"]);
    assert.equal(await service.removeWords({ userId, projectKey: projectA, words: ["Alpha", "Alpha"] }), 1);
    assert.deepEqual(await service.listWords({ userId, projectKey: projectA }), ["Beta"]);
    assert.deepEqual(await service.listWords({ userId, projectKey: projectB }), ["Alpha"]);
  });

  it("returns no context when project scope is absent", async () => {
    await service.addWords({ userId, projectKey: projectA, words: ["Alpha"] });

    assert.deepEqual(await service.getContextWords({ userId, projectKey: null }), []);
  });

  it("selects context by code-unit order without locale collation", async () => {
    await service.addWords({ userId, projectKey: projectA, words: ["Zebra", "apple", "Émile", "Apple"] });

    assert.deepEqual(await service.getContextWords({ userId, projectKey: projectA }), [
      "Apple",
      "Zebra",
      "apple",
      "Émile",
    ]);
  });

  it("takes the longest whole-term prefix within the context budget", async () => {
    const term = "x".repeat(100);
    const stored = words("", 0).concat(
      Array.from({ length: 120 }, (_, index) => `${String(index).padStart(3, "0")}${term}`),
    );
    await repo.insertMany({ userId, projectKey: projectA, words: stored });

    const context = await service.getContextWords({ userId, projectKey: projectA });

    assert.ok(context.length > 0 && context.length < stored.length);
    assert.ok(context.join(", ").length <= glossaryPolicy.maxContextCharacters);
    assert.ok(context.every((word) => word.length === term.length + 3));
    assert.deepEqual(context, [...stored].sort().slice(0, context.length));
  });
});

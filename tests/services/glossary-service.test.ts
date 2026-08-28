import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { BridgeRepository } from "../../src/repositories/bridge-repo.js";
import { GlossaryEntryRepository } from "../../src/repositories/glossary-entry-repo.js";
import { GlossaryService, glossaryPolicy } from "../../src/services/glossary-service.js";
import type { GlossaryEntry } from "../../src/models/documents.js";
import {
  ProjectGlossaryScopeType,
  projectKeySchema,
  type ProjectGlossaryScope,
  type ProjectKey,
} from "../../src/models/voice.js";
import { BadRequestError } from "../../src/lib/errors.js";
import { BridgePlatform } from "../../src/models/bridge.js";
import { renderTranscriptionPrompt } from "../../src/types/transcription.js";
import { MongoDbDatabase, AuthDbCollection } from "../../src/types/mongo.js";

const projectA = projectKeySchema.parse(`prj_v1_${"A".repeat(43)}`);
const projectB = projectKeySchema.parse(`prj_v1_${"B".repeat(43)}`);

function repositoryScope(projectKey: ProjectKey): ProjectGlossaryScope {
  return { type: ProjectGlossaryScopeType.repository, projectKey };
}

function bridgeLocalScope(args: { projectKey: ProjectKey; bridgeId: string }): ProjectGlossaryScope {
  return { type: ProjectGlossaryScopeType.bridgeLocal, ...args };
}

function words(prefix: string, count: number, start = 0): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(start + index).padStart(5, "0")}`);
}

describe("GlossaryService", () => {
  let ctx: TestContext;
  let repo: GlossaryEntryRepository;
  let bridgeRepo: BridgeRepository;
  let service: GlossaryService;
  let userId: string;

  before(async () => {
    ctx = await createTestApp();
    repo = new GlossaryEntryRepository(ctx.dbAccessor);
    bridgeRepo = new BridgeRepository(ctx.dbAccessor);
    service = new GlossaryService({ glossaryRepo: repo, bridgeRepo });
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
    const added = await service.addWords({
      userId,
      scope: repositoryScope(projectA),
      words: ["Beta", "Alpha", "Beta"],
    });

    assert.deepEqual(added, ["Beta", "Alpha"]);
  });

  it("rejects local glossary mutations for an inactive bridge", async () => {
    const scope = bridgeLocalScope({ projectKey: projectA, bridgeId: "br_missing0001" });
    await assert.rejects(() => service.addWords({ userId, scope, words: ["Blocked"] }), BadRequestError);
    await assert.rejects(() => service.removeWords({ userId, scope, words: ["Blocked"] }), BadRequestError);
    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectA }), 0);
  });

  it("removes a raced local write when the bridge is revoked during insertion", async () => {
    let activeChecks = 0;
    const findByIdForUser = mock.fn(async () => (activeChecks++ === 0 ? {} : null));
    const racingService = new GlossaryService({
      glossaryRepo: repo,
      bridgeRepo: { findByIdForUser } as unknown as BridgeRepository,
    });

    await assert.rejects(
      () =>
        racingService.addWords({
          userId,
          scope: bridgeLocalScope({ projectKey: projectA, bridgeId: "br_bridge0001" }),
          words: ["Raced"],
        }),
      BadRequestError,
    );
    assert.equal(findByIdForUser.mock.callCount(), 2);
    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectA }), 0);
  });

  it("keeps idempotency and removal exact while aggregating shared vocabulary", async () => {
    const firstBridge = await bridgeRepo.register({
      userId,
      name: "First",
      platform: BridgePlatform.macos,
    });
    const secondBridge = await bridgeRepo.register({
      userId,
      name: "Second",
      platform: BridgePlatform.linux,
    });
    const repository = repositoryScope(projectA);
    const firstLocal = bridgeLocalScope({ projectKey: projectA, bridgeId: firstBridge.bridgeId });
    const secondLocal = bridgeLocalScope({ projectKey: projectA, bridgeId: secondBridge.bridgeId });

    assert.deepEqual(await service.addWords({ userId, scope: repository, words: ["Shared"] }), ["Shared"]);
    assert.deepEqual(await service.addWords({ userId, scope: firstLocal, words: ["Shared"] }), ["Shared"]);
    assert.deepEqual(await service.addWords({ userId, scope: firstLocal, words: ["Shared"] }), []);
    assert.deepEqual(await service.addWords({ userId, scope: secondLocal, words: ["Shared"] }), ["Shared"]);
    assert.deepEqual(await service.listWords({ userId, projectKey: projectA }), ["Shared"]);
    assert.deepEqual(await service.getContextWords({ userId, projectKey: projectA }), ["Shared"]);

    assert.equal(await service.removeWords({ userId, scope: repository, words: ["Shared"] }), 1);
    assert.deepEqual(await service.listWords({ userId, projectKey: projectA }), ["Shared"]);
    assert.equal(await service.removeWords({ userId, scope: firstLocal, words: ["Shared"] }), 1);
    assert.deepEqual(await service.listWords({ userId, projectKey: projectA }), ["Shared"]);
    assert.equal(await service.removeWords({ userId, scope: secondLocal, words: ["Shared"] }), 1);
    assert.deepEqual(await service.listWords({ userId, projectKey: projectA }), []);
  });

  it("truncates to the remaining per-project capacity", async () => {
    await repo.addWords({
      userId,
      scope: repositoryScope(projectA),
      words: words("p", glossaryPolicy.maxWordsPerProject - 2),
    });

    const added = await service.addWords({ userId, scope: repositoryScope(projectA), words: ["One", "Two", "Three"] });

    assert.deepEqual(added, ["One", "Two"]);
    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectA }), glossaryPolicy.maxWordsPerProject);
  });

  it("truncates to the remaining per-user capacity across projects", async () => {
    const perProject = glossaryPolicy.maxWordsPerProject;
    const projects = Array.from({ length: 9 }, (_, index) =>
      projectKeySchema.parse(`prj_v1_${String(index).repeat(43)}`),
    );
    for (const [index, projectKey] of projects.entries()) {
      await repo.addWords({ userId, scope: repositoryScope(projectKey), words: words(`u${index}_`, perProject) });
    }
    await repo.addWords({ userId, scope: repositoryScope(projectA), words: words("tail_", 499) });

    const added = await service.addWords({ userId, scope: repositoryScope(projectA), words: ["Last", "Overflow"] });

    assert.deepEqual(added, ["Last"]);
    assert.equal(await repo.countScopedByUserId(userId), glossaryPolicy.maxWordsPerUser);
  });

  it("adds nothing and never passes a negative limit when a cap is already exceeded", async () => {
    await repo.addWords({
      userId,
      scope: repositoryScope(projectA),
      words: words("over", glossaryPolicy.maxWordsPerProject + 5),
    });

    const added = await service.addWords({ userId, scope: repositoryScope(projectA), words: ["Blocked"] });

    assert.deepEqual(added, []);
    assert.equal(
      await repo.countByUserAndProject({ userId, projectKey: projectA }),
      glossaryPolicy.maxWordsPerProject + 5,
    );
  });

  it("does not let an already-stored word consume the last free capacity slot", async () => {
    await repo.addWords({
      userId,
      scope: repositoryScope(projectA),
      words: [...words("w", glossaryPolicy.maxWordsPerProject - 2), "Dup"],
    });

    const added = await service.addWords({ userId, scope: repositoryScope(projectA), words: ["Dup", "BrandNew"] });

    assert.deepEqual(added, ["BrandNew"]);
  });

  it("rejects an invalid request before performing any database work", async () => {
    let queried = false;
    const spyRepo = {
      findWordsByUserAndScope: async () => {
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
      addWords: async () => [],
      removeWords: async () => 0,
    } as unknown as GlossaryEntryRepository;
    const spyService = new GlossaryService({ glossaryRepo: spyRepo, bridgeRepo });

    await assert.rejects(
      () =>
        spyService.addWords({
          userId,
          scope: repositoryScope(projectA),
          words: words("x", glossaryPolicy.maxWordsPerRequest + 1),
        }),
      BadRequestError,
    );
    assert.equal(queried, false, "no query should run for a request that is guaranteed to be rejected");
  });

  it("enforces request and word-length caps for non-route callers", async () => {
    await assert.rejects(
      () =>
        service.addWords({
          userId,
          scope: repositoryScope(projectA),
          words: words("x", glossaryPolicy.maxWordsPerRequest + 1),
        }),
      BadRequestError,
    );
    await assert.rejects(
      () =>
        service.addWords({
          userId,
          scope: repositoryScope(projectA),
          words: ["y".repeat(glossaryPolicy.maxWordCharacters + 1)],
        }),
      BadRequestError,
    );
    await assert.rejects(
      () => service.addWords({ userId, scope: repositoryScope(projectA), words: ["   "] }),
      BadRequestError,
    );
    await assert.rejects(
      () =>
        service.removeWords({
          userId,
          scope: repositoryScope(projectA),
          words: words("z", glossaryPolicy.maxWordsPerRequest + 1),
        }),
      BadRequestError,
    );
  });

  it("keeps the rendered prompt within the context budget", async () => {
    const termSuffix = "x".repeat(glossaryPolicy.maxWordCharacters - 3);
    await repo.addWords({
      userId,
      scope: repositoryScope(projectA),
      words: Array.from({ length: 90 }, (_, index) => `${String(index).padStart(3, "0")}${termSuffix}`),
    });

    const prompt = renderTranscriptionPrompt(await service.getContextWords({ userId, projectKey: projectA }));

    assert.ok(prompt);
    assert.ok(
      prompt.length <= glossaryPolicy.maxContextCharacters,
      `rendered prompt ${prompt.length} exceeded ${glossaryPolicy.maxContextCharacters}`,
    );
  });

  it("builds no prompt without project context or terms", async () => {
    assert.equal(renderTranscriptionPrompt(await service.getContextWords({ userId, projectKey: null })), null);
    assert.equal(renderTranscriptionPrompt(await service.getContextWords({ userId, projectKey: projectA })), null);
  });

  it("lists by project and removes only within one exact scope", async () => {
    const scopeA = repositoryScope(projectA);
    await service.addWords({ userId, scope: scopeA, words: ["Alpha", "Beta"] });
    await service.addWords({ userId, scope: repositoryScope(projectB), words: ["Alpha"] });

    assert.deepEqual(await service.listWords({ userId, projectKey: projectA }), ["Alpha", "Beta"]);
    assert.equal(await service.removeWords({ userId, scope: scopeA, words: ["Alpha", "Alpha"] }), 1);
    assert.deepEqual(await service.listWords({ userId, projectKey: projectA }), ["Beta"]);
    assert.deepEqual(await service.listWords({ userId, projectKey: projectB }), ["Alpha"]);
  });

  it("returns no context when project scope is absent", async () => {
    await service.addWords({ userId, scope: repositoryScope(projectA), words: ["Alpha"] });

    assert.deepEqual(await service.getContextWords({ userId, projectKey: null }), []);
  });

  it("selects context by code-unit order without locale collation", async () => {
    await service.addWords({
      userId,
      scope: repositoryScope(projectA),
      words: ["Zebra", "apple", "Émile", "Apple"],
    });

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
    await repo.addWords({ userId, scope: repositoryScope(projectA), words: stored });

    const context = await service.getContextWords({ userId, projectKey: projectA });

    assert.ok(context.length > 0 && context.length < stored.length);
    assert.ok(context.join(", ").length <= glossaryPolicy.maxContextCharacters);
    assert.ok(context.every((word) => word.length === term.length + 3));
    assert.deepEqual(context, [...stored].sort().slice(0, context.length));
  });
});

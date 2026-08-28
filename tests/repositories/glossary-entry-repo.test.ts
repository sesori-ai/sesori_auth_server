import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { GlossaryEntryRepository } from "../../src/repositories/glossary-entry-repo.js";
import { InternalServerError } from "../../src/lib/errors.js";
import type { GlossaryEntry } from "../../src/models/documents.js";
import {
  ProjectGlossaryScopeType,
  projectKeySchema,
  type ProjectGlossaryScope,
  type ProjectKey,
} from "../../src/models/voice.js";
import { MongoDbDatabase, AuthDbCollection } from "../../src/types/mongo.js";

const projectA = projectKeySchema.parse(`prj_v1_${"A".repeat(43)}`);
const projectB = projectKeySchema.parse(`prj_v1_${"B".repeat(43)}`);

function repositoryScope(projectKey: ProjectKey): ProjectGlossaryScope {
  return { type: ProjectGlossaryScopeType.repository, projectKey };
}

function bridgeLocalScope(args: { projectKey: ProjectKey; bridgeId: string }): ProjectGlossaryScope {
  return { type: ProjectGlossaryScopeType.bridgeLocal, ...args };
}

describe("GlossaryEntryRepository", () => {
  let ctx: TestContext;
  let repo: GlossaryEntryRepository;
  let userId: string;

  before(async () => {
    ctx = await createTestApp();
    repo = new GlossaryEntryRepository(ctx.dbAccessor);
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

  function insertRaw(document: Record<string, unknown>): Promise<unknown> {
    return ctx.dbAccessor.getDb(MongoDbDatabase.Auth).collection(AuthDbCollection.GlossaryEntries).insertOne(document);
  }

  it("persists project scope and returns only the requested project's words", async () => {
    await repo.insertMany({ userId, scope: repositoryScope(projectA), words: ["Beta", "Alpha"] });
    await repo.insertMany({ userId, scope: repositoryScope(projectB), words: ["Gamma"] });

    const words = await repo.findWordsByUserAndProject({ userId, projectKey: projectA });

    assert.deepEqual(words, ["Alpha", "Beta"]);
    assert.ok(
      words.every((word) => typeof word === "string"),
      "documents must not escape the repository boundary",
    );
  });

  it("keeps the same word independent across projects and users", async () => {
    const otherUserId = new ObjectId().toHexString();

    assert.deepEqual(await repo.insertMany({ userId, scope: repositoryScope(projectA), words: ["Shared"] }), [
      "Shared",
    ]);
    assert.deepEqual(await repo.insertMany({ userId, scope: repositoryScope(projectB), words: ["Shared"] }), [
      "Shared",
    ]);
    assert.deepEqual(
      await repo.insertMany({ userId: otherUserId, scope: repositoryScope(projectA), words: ["Shared"] }),
      ["Shared"],
    );
  });

  it("treats a repeated word in the same project as an idempotent duplicate", async () => {
    await repo.insertMany({ userId, scope: repositoryScope(projectA), words: ["Alpha"] });

    const inserted = await repo.insertMany({
      userId,
      scope: repositoryScope(projectA),
      words: ["Alpha", "Beta"],
    });

    assert.deepEqual(inserted, ["Beta"]);
    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectA }), 2);
  });

  it("counts per project and per user", async () => {
    await repo.insertMany({ userId, scope: repositoryScope(projectA), words: ["Alpha", "Beta"] });
    await repo.insertMany({ userId, scope: repositoryScope(projectB), words: ["Gamma"] });

    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectA }), 2);
    assert.equal(await repo.countScopedByUserId(userId), 3);
  });

  it("deletes only words within the requested project", async () => {
    await repo.insertMany({ userId, scope: repositoryScope(projectA), words: ["Alpha", "Beta"] });
    await repo.insertMany({ userId, scope: repositoryScope(projectB), words: ["Alpha"] });

    assert.equal(await repo.deleteMany({ userId, projectKey: projectA, words: ["Alpha"] }), 1);
    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectA }), 1);
    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectB }), 1);
  });

  it("deletes bridge-local entries without touching shared repositories or other accounts", async () => {
    const otherUserId = new ObjectId().toHexString();
    const targetBridgeId = "br_bridge0001";
    const otherBridgeId = "br_bridge0002";

    await repo.insertMany({
      userId,
      scope: bridgeLocalScope({ projectKey: projectA, bridgeId: targetBridgeId }),
      words: ["Local"],
    });
    await repo.insertMany({ userId, scope: repositoryScope(projectB), words: ["Repository"] });
    await repo.insertMany({
      userId,
      scope: bridgeLocalScope({ projectKey: projectB, bridgeId: otherBridgeId }),
      words: ["OtherBridge"],
    });
    await repo.insertMany({
      userId: otherUserId,
      scope: bridgeLocalScope({ projectKey: projectA, bridgeId: targetBridgeId }),
      words: ["OtherUser"],
    });

    assert.equal(await repo.deleteByUserAndBridge({ userId, bridgeId: targetBridgeId }), 1);
    assert.deepEqual(await repo.findWordsByUserAndProject({ userId, projectKey: projectA }), []);
    assert.deepEqual(await repo.findWordsByUserAndProject({ userId, projectKey: projectB }), [
      "OtherBridge",
      "Repository",
    ]);
    assert.deepEqual(await repo.findWordsByUserAndProject({ userId: otherUserId, projectKey: projectA }), [
      "OtherUser",
    ]);

    assert.equal(await repo.deleteAllBridgeLocalByUser({ userId }), 1);
    assert.deepEqual(await repo.findWordsByUserAndProject({ userId, projectKey: projectB }), ["Repository"]);
  });

  it("performs no database work for empty word lists", async () => {
    assert.deepEqual(await repo.insertMany({ userId, scope: repositoryScope(projectA), words: [] }), []);
    assert.equal(await repo.deleteMany({ userId, projectKey: projectA, words: [] }), 0);
  });

  it("fails closed on a malformed persisted document without leaking its content", async () => {
    await insertRaw({
      _id: new ObjectId(),
      userId: new ObjectId(userId),
      scope: repositoryScope(projectA),
      word: "Broken",
      createdAt: new Date(),
      unexpected: "SecretValue",
    });

    await assert.rejects(
      () => repo.findWordsByUserAndProject({ userId, projectKey: projectA }),
      (error: unknown) => {
        assert.ok(error instanceof InternalServerError);
        assert.equal(error.message, "internal_server_error");
        const diagnostics = `${error.debugMessage ?? ""}${JSON.stringify(error.nestedError ?? null)}`;
        assert.ok(!diagnostics.includes("Broken") && !diagnostics.includes("SecretValue"));
        return true;
      },
    );
  });
});

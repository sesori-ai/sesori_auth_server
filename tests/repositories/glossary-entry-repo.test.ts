import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MongoServerError, ObjectId } from "mongodb";
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
import type { MongoDbAccessor } from "../../src/db/mongo-db-accessor.js";

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
    await repo.addWords({ userId, scope: repositoryScope(projectA), words: ["Beta", "Alpha"] });
    await repo.addWords({ userId, scope: repositoryScope(projectB), words: ["Gamma"] });

    const words = await repo.findWordsByUserAndProject({ userId, projectKey: projectA });
    const documents = await ctx.dbAccessor
      .getCollection<GlossaryEntry>(MongoDbDatabase.Auth, AuthDbCollection.GlossaryEntries)
      .find({ userId: new ObjectId(userId), "scope.projectKey": projectA })
      .toArray();

    assert.equal(documents.length, 1);
    assert.deepEqual(documents[0]?.words, ["Beta", "Alpha"]);
    assert.deepEqual(words, ["Alpha", "Beta"]);
    assert.ok(
      words.every((word) => typeof word === "string"),
      "documents must not escape the repository boundary",
    );
  });

  it("keeps the same word independent across projects and users", async () => {
    const otherUserId = new ObjectId().toHexString();

    assert.deepEqual(await repo.addWords({ userId, scope: repositoryScope(projectA), words: ["Shared"] }), ["Shared"]);
    assert.deepEqual(await repo.addWords({ userId, scope: repositoryScope(projectB), words: ["Shared"] }), ["Shared"]);
    assert.deepEqual(
      await repo.addWords({ userId: otherUserId, scope: repositoryScope(projectA), words: ["Shared"] }),
      ["Shared"],
    );
  });

  it("keeps the same word independent across exact ownership scopes", async () => {
    const repository = repositoryScope(projectA);
    const firstLocal = bridgeLocalScope({ projectKey: projectA, bridgeId: "br_bridge0001" });
    const secondLocal = bridgeLocalScope({ projectKey: projectA, bridgeId: "br_bridge0002" });

    assert.deepEqual(await repo.addWords({ userId, scope: repository, words: ["Shared"] }), ["Shared"]);
    assert.deepEqual(await repo.addWords({ userId, scope: firstLocal, words: ["Shared"] }), ["Shared"]);
    assert.deepEqual(await repo.addWords({ userId, scope: secondLocal, words: ["Shared"] }), ["Shared"]);

    assert.deepEqual(await repo.findWordsByUserAndProject({ userId, projectKey: projectA }), ["Shared"]);
    assert.deepEqual(await repo.findWordsByUserAndScope({ userId, scope: repository }), ["Shared"]);
    assert.deepEqual(await repo.findWordsByUserAndScope({ userId, scope: firstLocal }), ["Shared"]);
    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectA }), 3);

    assert.equal(await repo.removeWords({ userId, scope: repository, words: ["Shared"] }), 1);
    assert.deepEqual(await repo.findWordsByUserAndProject({ userId, projectKey: projectA }), ["Shared"]);
    assert.equal(await repo.removeWords({ userId, scope: firstLocal, words: ["Shared"] }), 1);
    assert.deepEqual(await repo.findWordsByUserAndProject({ userId, projectKey: projectA }), ["Shared"]);
    assert.equal(await repo.removeWords({ userId, scope: secondLocal, words: ["Shared"] }), 1);
    assert.deepEqual(await repo.findWordsByUserAndProject({ userId, projectKey: projectA }), []);
    assert.equal(
      await ctx.dbAccessor
        .getCollection<GlossaryEntry>(MongoDbDatabase.Auth, AuthDbCollection.GlossaryEntries)
        .countDocuments({ userId: new ObjectId(userId), "scope.projectKey": projectA }),
      0,
    );
  });

  it("treats a repeated word in the same exact scope as an idempotent duplicate", async () => {
    await repo.addWords({ userId, scope: repositoryScope(projectA), words: ["Alpha"] });

    const inserted = await repo.addWords({
      userId,
      scope: repositoryScope(projectA),
      words: ["Alpha", "Beta"],
    });

    assert.deepEqual(inserted, ["Beta"]);
    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectA }), 2);
  });

  it("atomically creates one scope document for concurrent first writes", async () => {
    const scope = repositoryScope(projectA);

    const results = await Promise.all([
      repo.addWords({ userId, scope, words: ["Shared"] }),
      repo.addWords({ userId, scope, words: ["Shared"] }),
    ]);

    assert.deepEqual(results.flat(), ["Shared"]);
    const documents = await ctx.dbAccessor
      .getCollection<GlossaryEntry>(MongoDbDatabase.Auth, AuthDbCollection.GlossaryEntries)
      .find({ userId: new ObjectId(userId), "scope.projectKey": projectA })
      .toArray();
    assert.equal(documents.length, 1);
    assert.deepEqual(documents[0]?.words, ["Shared"]);
  });

  it("retries repeated exact-scope upsert collisions", async () => {
    let attempts = 0;
    const duplicateKeyError = new MongoServerError({ ok: 0, code: 11000, errmsg: "duplicate exact scope" });
    const retryingRepo = new GlossaryEntryRepository({
      getCollection: () => ({
        findOneAndUpdate: async () => {
          attempts += 1;
          if (attempts <= 3) {
            throw duplicateKeyError;
          }
          return null;
        },
      }),
    } as unknown as MongoDbAccessor);

    assert.deepEqual(await retryingRepo.addWords({ userId, scope: repositoryScope(projectA), words: ["Shared"] }), [
      "Shared",
    ]);
    assert.equal(attempts, 4);
  });

  it("bounds retries for a persistent exact-scope uniqueness conflict", async () => {
    let attempts = 0;
    const duplicateKeyError = new MongoServerError({ ok: 0, code: 11000, errmsg: "persistent conflict" });
    const retryingRepo = new GlossaryEntryRepository({
      getCollection: () => ({
        findOneAndUpdate: async () => {
          attempts += 1;
          throw duplicateKeyError;
        },
      }),
    } as unknown as MongoDbAccessor);

    await assert.rejects(
      () => retryingRepo.addWords({ userId, scope: repositoryScope(projectA), words: ["Shared"] }),
      (error: unknown) => error === duplicateKeyError,
    );
    assert.equal(attempts, 5);
  });

  it("counts per project and per user", async () => {
    await repo.addWords({ userId, scope: repositoryScope(projectA), words: ["Alpha", "Beta"] });
    await repo.addWords({ userId, scope: repositoryScope(projectB), words: ["Gamma"] });

    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectA }), 2);
    assert.equal(await repo.countScopedByUserId(userId), 3);
  });

  it("deletes only words within the requested scope", async () => {
    const scopeA = repositoryScope(projectA);
    await repo.addWords({ userId, scope: scopeA, words: ["Alpha", "Beta"] });
    await repo.addWords({ userId, scope: repositoryScope(projectB), words: ["Alpha"] });

    assert.equal(await repo.removeWords({ userId, scope: scopeA, words: ["Alpha"] }), 1);
    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectA }), 1);
    assert.equal(await repo.countByUserAndProject({ userId, projectKey: projectB }), 1);
  });

  it("cleans up an already-empty scope document when removal is retried", async () => {
    const scope = repositoryScope(projectA);
    await insertRaw({
      _id: new ObjectId(),
      userId: new ObjectId(userId),
      scope,
      words: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    assert.equal(await repo.removeWords({ userId, scope, words: ["AlreadyRemoved"] }), 0);
    assert.equal(
      await ctx.dbAccessor
        .getCollection<GlossaryEntry>(MongoDbDatabase.Auth, AuthDbCollection.GlossaryEntries)
        .countDocuments({ userId: new ObjectId(userId), "scope.projectKey": projectA }),
      0,
    );
  });

  it("deletes bridge-local entries without touching shared repositories or other accounts", async () => {
    const otherUserId = new ObjectId().toHexString();
    const targetBridgeId = "br_bridge0001";
    const otherBridgeId = "br_bridge0002";

    await repo.addWords({
      userId,
      scope: bridgeLocalScope({ projectKey: projectA, bridgeId: targetBridgeId }),
      words: ["Local"],
    });
    await repo.addWords({ userId, scope: repositoryScope(projectB), words: ["Repository"] });
    await repo.addWords({
      userId,
      scope: bridgeLocalScope({ projectKey: projectB, bridgeId: otherBridgeId }),
      words: ["OtherBridge"],
    });
    await repo.addWords({
      userId: otherUserId,
      scope: bridgeLocalScope({ projectKey: projectA, bridgeId: targetBridgeId }),
      words: ["OtherUser"],
    });

    assert.deepEqual((await repo.findBridgeLocalOwnerIdsByUser({ userId })).sort(), [targetBridgeId, otherBridgeId]);
    assert.equal(await repo.deleteByUserAndBridges({ userId, bridgeIds: [targetBridgeId] }), 1);
    assert.deepEqual(await repo.findWordsByUserAndProject({ userId, projectKey: projectA }), []);
    assert.deepEqual(await repo.findWordsByUserAndProject({ userId, projectKey: projectB }), [
      "OtherBridge",
      "Repository",
    ]);
    assert.deepEqual(await repo.findWordsByUserAndProject({ userId: otherUserId, projectKey: projectA }), [
      "OtherUser",
    ]);
  });

  it("performs no database work for empty word or bridge lists", async () => {
    const scope = repositoryScope(projectA);
    assert.deepEqual(await repo.addWords({ userId, scope, words: [] }), []);
    assert.equal(await repo.removeWords({ userId, scope, words: [] }), 0);
    assert.equal(await repo.deleteByUserAndBridges({ userId, bridgeIds: [] }), 0);
  });

  it("fails closed on malformed persisted words without leaking their content", async () => {
    const malformedCases = [
      {
        fields: { words: ["Broken"], unexpected: "SecretValue" },
        secrets: ["Broken", "SecretValue"],
      },
      { fields: { words: [""] }, secrets: [] },
      { fields: { words: [" PaddedSecretValue "] }, secrets: ["PaddedSecretValue"] },
      { fields: { words: ["LongSecretValue".repeat(20)] }, secrets: ["LongSecretValue"] },
    ];

    for (const malformed of malformedCases) {
      await insertRaw({
        _id: new ObjectId(),
        userId: new ObjectId(userId),
        scope: repositoryScope(projectA),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...malformed.fields,
      });

      await assert.rejects(
        () => repo.findWordsByUserAndProject({ userId, projectKey: projectA }),
        (error: unknown) => {
          assert.ok(error instanceof InternalServerError);
          assert.equal(error.message, "internal_server_error");
          const diagnostics = `${error.debugMessage ?? ""}${JSON.stringify(error.nestedError ?? null)}`;
          assert.ok(malformed.secrets.every((secret) => !diagnostics.includes(secret)));
          return true;
        },
      );
      await ctx.dbAccessor
        .getCollection<GlossaryEntry>(MongoDbDatabase.Auth, AuthDbCollection.GlossaryEntries)
        .deleteMany({});
    }
  });
});

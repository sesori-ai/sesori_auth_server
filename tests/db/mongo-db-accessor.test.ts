import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { indexKeyMatches, indexMatchesDesired, type IndexDefinition } from "../../src/db/mongo-db-accessor.js";
import { createTestApp } from "../helpers/setup.js";
import { MongoDbDatabase, AuthDbCollection } from "../../src/types/mongo.js";

describe("indexKeyMatches", () => {
  it("returns true for identical single-field specs", () => {
    assert.equal(indexKeyMatches({ email: 1 }, { email: 1 }), true);
  });

  it("returns true for identical compound specs", () => {
    assert.equal(indexKeyMatches({ userId: 1, word: 1 }, { userId: 1, word: 1 }), true);
  });

  it("returns false when field order differs", () => {
    assert.equal(indexKeyMatches({ a: 1, b: 1 }, { b: 1, a: 1 }), false);
  });

  it("returns false when field names differ", () => {
    assert.equal(indexKeyMatches({ email: 1 }, { userId: 1 }), false);
  });

  it("returns false when key directions differ", () => {
    assert.equal(indexKeyMatches({ email: 1 }, { email: -1 }), false);
  });

  it("returns false when key count differs", () => {
    assert.equal(indexKeyMatches({ email: 1 }, { email: 1, userId: 1 }), false);
  });
});

describe("fresh glossary index normalization", () => {
  it("replaces stale indexes only while the glossary collection is empty", async () => {
    const ctx = await createTestApp();
    try {
      const collection = ctx.dbAccessor.getDb(MongoDbDatabase.Auth).collection(AuthDbCollection.GlossaryEntries);
      const target = (await collection.indexes()).find((index) =>
        indexKeyMatches(index.key, { userId: 1, "scope.projectKey": 1, word: 1 }),
      );
      assert.ok(target?.name);
      await collection.dropIndex(target.name);
      await collection.createIndex({ userId: 1, word: 1 }, { unique: true });
      await collection.createIndex({ userId: 1, "scope.projectKey": 1, word: 1 }, { unique: true, sparse: true });

      await ctx.dbAccessor.ensureIndexes();

      const indexes = await collection.indexes();
      assert.equal(
        indexes.some((index) => indexKeyMatches(index.key, { userId: 1, word: 1 })),
        false,
      );
      const normalizedTarget = indexes.find((index) =>
        indexKeyMatches(index.key, { userId: 1, "scope.projectKey": 1, word: 1 }),
      );
      assert.ok(normalizedTarget);
      assert.notEqual(normalizedTarget.sparse, true);
    } finally {
      await ctx.cleanup();
    }
  });

  it("refuses to create a missing target index over unexpected glossary data", async () => {
    const ctx = await createTestApp();
    try {
      const collection = ctx.dbAccessor.getDb(MongoDbDatabase.Auth).collection(AuthDbCollection.GlossaryEntries);
      const target = (await collection.indexes()).find((index) =>
        indexKeyMatches(index.key, { userId: 1, "scope.projectKey": 1, word: 1 }),
      );
      assert.ok(target?.name);
      await collection.dropIndex(target.name);
      await collection.insertOne({ userId: "unexpected", word: "Sesori" });

      await assert.rejects(
        () => ctx.dbAccessor.ensureIndexes(),
        /Glossary schema reset refused: the collection unexpectedly contains data/,
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("refuses a collection with non-simple default collation", async () => {
    const ctx = await createTestApp();
    try {
      const db = ctx.dbAccessor.getDb(MongoDbDatabase.Auth);
      await db.dropCollection(AuthDbCollection.GlossaryEntries);
      await db.createCollection(AuthDbCollection.GlossaryEntries, {
        collation: { locale: "en", strength: 2 },
      });

      await assert.rejects(
        () => ctx.dbAccessor.ensureIndexes(),
        /Glossary schema reset refused: the collection has non-simple default collation/,
      );
    } finally {
      await ctx.cleanup();
    }
  });
});

describe("indexMatchesDesired", () => {
  it("returns true when key and unique option match", () => {
    const existing = { key: { email: 1 }, unique: true, name: "email_1", v: 2 };
    const desired: IndexDefinition = { spec: { email: 1 }, options: { unique: true } };
    assert.equal(indexMatchesDesired(existing, desired), true);
  });

  it("returns true when key matches and both are non-unique", () => {
    const existing = { key: { userId: 1 }, name: "userId_1", v: 2 };
    const desired: IndexDefinition = { spec: { userId: 1 } };
    assert.equal(indexMatchesDesired(existing, desired), true);
  });

  it("returns false when key differs", () => {
    const existing = { key: { email: 1 }, unique: true, name: "email_1", v: 2 };
    const desired: IndexDefinition = { spec: { userId: 1 }, options: { unique: true } };
    assert.equal(indexMatchesDesired(existing, desired), false);
  });

  it("returns false when unique option differs", () => {
    const existing = { key: { userId: 1 }, name: "userId_1", v: 2 };
    const desired: IndexDefinition = { spec: { userId: 1 }, options: { unique: true } };
    assert.equal(indexMatchesDesired(existing, desired), false);
  });

  it("returns false when existing is unique but desired is not", () => {
    const existing = { key: { userId: 1 }, unique: true, name: "userId_1", v: 2 };
    const desired: IndexDefinition = { spec: { userId: 1 } };
    assert.equal(indexMatchesDesired(existing, desired), false);
  });
});

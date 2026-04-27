import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { indexKeyMatches, indexMatchesDesired, type IndexDefinition } from "../../src/db/mongo-db-accessor.js";

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

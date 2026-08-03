import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ObjectId } from "mongodb";
import {
  legacyGlossaryEntryMigrationSchema,
  projectScopedGlossaryEntryMigrationSchema,
} from "../../src/models/documents.js";
import { projectKeySchema } from "../../src/models/voice.js";

const validProjectKey = `prj_v1_${"A".repeat(43)}`;

describe("projectKeySchema", () => {
  it("accepts exactly the versioned base64url SHA-256 shape", () => {
    assert.equal(projectKeySchema.safeParse(validProjectKey).success, true);
    assert.equal(projectKeySchema.safeParse(`prj_v1_${"a0_-".repeat(10)}abc`).success, true);
  });

  it("rejects wrong prefixes, lengths, padding, non-base64url characters, and whitespace", () => {
    const invalid = [
      `prj_v2_${"A".repeat(43)}`,
      `prj_v1_${"A".repeat(42)}`,
      `prj_v1_${"A".repeat(44)}`,
      `prj_v1_${"A".repeat(42)}=`,
      `prj_v1_${"A".repeat(42)}+`,
      `prj_v1_${"A".repeat(42)}/`,
      `${validProjectKey}\n`,
      ` ${validProjectKey}`,
    ];

    for (const value of invalid) {
      assert.equal(projectKeySchema.safeParse(value).success, false, value);
    }
  });
});

describe("glossary migration document schemas", () => {
  const legacyDocument = {
    _id: new ObjectId(),
    userId: new ObjectId(),
    word: "Sesori",
    createdAt: new Date("2026-08-02T00:00:00.000Z"),
  };

  it("keeps strict legacy and project-scoped shapes separate", () => {
    assert.equal(legacyGlossaryEntryMigrationSchema.safeParse(legacyDocument).success, true);
    assert.equal(
      projectScopedGlossaryEntryMigrationSchema.safeParse({ ...legacyDocument, projectKey: validProjectKey }).success,
      true,
    );
    assert.equal(projectScopedGlossaryEntryMigrationSchema.safeParse(legacyDocument).success, false);
    assert.equal(
      legacyGlossaryEntryMigrationSchema.safeParse({ ...legacyDocument, projectKey: validProjectKey }).success,
      false,
    );
  });

  it("rejects malformed fields and unknown persisted fields", () => {
    assert.equal(legacyGlossaryEntryMigrationSchema.safeParse({ ...legacyDocument, word: 42 }).success, false);
    assert.equal(
      projectScopedGlossaryEntryMigrationSchema.safeParse({
        ...legacyDocument,
        projectKey: validProjectKey,
        unexpected: true,
      }).success,
      false,
    );
  });
});

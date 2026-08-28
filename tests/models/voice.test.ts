import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProjectGlossaryScopeType,
  glossaryAddBodySchema,
  glossaryRemoveBodySchema,
  projectGlossaryScopeSchema,
  projectKeySchema,
} from "../../src/models/voice.js";

const validProjectKey = `prj_v1_${"A".repeat(43)}`;

describe("projectGlossaryScopeSchema", () => {
  it("accepts complete repository and bridge-local variants", () => {
    assert.equal(
      projectGlossaryScopeSchema.safeParse({
        type: ProjectGlossaryScopeType.repository,
        projectKey: validProjectKey,
      }).success,
      true,
    );
    assert.equal(
      projectGlossaryScopeSchema.safeParse({
        type: ProjectGlossaryScopeType.bridgeLocal,
        projectKey: validProjectKey,
        bridgeId: "br_bridge0001",
      }).success,
      true,
    );
  });

  it("rejects missing, misplaced, and nullable bridge ownership", () => {
    const invalid = [
      { type: ProjectGlossaryScopeType.bridgeLocal, projectKey: validProjectKey },
      { type: ProjectGlossaryScopeType.bridgeLocal, projectKey: validProjectKey, bridgeId: null },
      { type: ProjectGlossaryScopeType.repository, projectKey: validProjectKey, bridgeId: "br_bridge0001" },
      { type: "unknown", projectKey: validProjectKey },
    ];

    for (const scope of invalid) {
      assert.equal(projectGlossaryScopeSchema.safeParse(scope).success, false, JSON.stringify(scope));
    }
  });
});

describe("glossary mutation schemas", () => {
  it("requires the strong scope variant for add and remove", () => {
    const request = {
      scope: { type: ProjectGlossaryScopeType.repository, projectKey: validProjectKey },
      words: ["Sesori"],
    };

    assert.equal(glossaryAddBodySchema.safeParse(request).success, true);
    assert.equal(glossaryRemoveBodySchema.safeParse(request).success, true);
    assert.equal(glossaryAddBodySchema.safeParse({ projectKey: validProjectKey, words: ["Sesori"] }).success, false);
    assert.equal(glossaryRemoveBodySchema.safeParse({ projectKey: validProjectKey, words: ["Sesori"] }).success, false);
  });
});

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

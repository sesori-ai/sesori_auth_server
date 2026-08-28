import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

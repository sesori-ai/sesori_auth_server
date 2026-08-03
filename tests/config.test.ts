import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadGlossaryMigrationConfig } from "../src/config.js";

describe("loadGlossaryMigrationConfig", () => {
  it("returns only the validated MongoDB URI", () => {
    assert.deepEqual(
      loadGlossaryMigrationConfig({
        MONGODB_URI: "mongodb://localhost:27017/oauth",
        JWT_PRIVATE_KEY: "must-not-cross-the-cli-boundary",
      }),
      { mongodbUri: "mongodb://localhost:27017/oauth" },
    );
  });

  it("rejects missing and empty MongoDB URIs without loading web config", () => {
    assert.throws(() => loadGlossaryMigrationConfig({}), /GlossaryMigrationConfigError/);
    assert.throws(() => loadGlossaryMigrationConfig({ MONGODB_URI: "" }), /GlossaryMigrationConfigError/);
    assert.throws(
      () => loadGlossaryMigrationConfig({ MONGODB_URI: "not-a-mongodb-uri" }),
      /GlossaryMigrationConfigError/,
    );
  });
});

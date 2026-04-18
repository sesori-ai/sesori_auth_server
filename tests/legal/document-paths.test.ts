import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getLegalDocumentUrl } from "../../src/lib/legal-document-paths.js";

describe("legal document path resolution", () => {
  it("resolves the same asset files from src and dist module URLs", () => {
    const repoRoot = process.cwd();
    const srcModuleUrl = pathToFileURL(path.join(repoRoot, "src/index.ts")).href;
    const distModuleUrl = pathToFileURL(path.join(repoRoot, "dist/index.js")).href;

    const expectedTermsPath = path.join(repoRoot, "assets/legal/terms.md");
    const expectedPrivacyPath = path.join(repoRoot, "assets/legal/privacy.md");

    for (const moduleUrl of [srcModuleUrl, distModuleUrl]) {
      assert.equal(fileURLToPath(getLegalDocumentUrl(moduleUrl, "terms")), expectedTermsPath);
      assert.equal(fileURLToPath(getLegalDocumentUrl(moduleUrl, "privacy")), expectedPrivacyPath);
    }
  });
});

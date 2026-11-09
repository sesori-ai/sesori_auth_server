import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { getBuiltAtUrl, readBuiltAt } from "../src/lib/build-info.js";
import { createTestApp } from "./helpers/setup.js";

const COMMIT = "81b811f0123456789abcdef0123456789abcdef0";
const BUILT_AT = "2026-11-08T09:30:00Z";
const RELAY_SECRET = "relay-secret-that-must-not-leak";

describe("GET /version", () => {
  describe("with a bound commit and build time", () => {
    let app: FastifyInstance;
    let cleanup: () => Promise<void>;

    before(async () => {
      const ctx = await createTestApp({
        configOverrides: { GIT_COMMIT_SHA: COMMIT, RELAY_WEBHOOK_SECRET: RELAY_SECRET },
        builtAt: BUILT_AT,
      });
      app = ctx.app;
      cleanup = ctx.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it("returns the commit and build time without authentication", async () => {
      const res = await app.inject({ method: "GET", url: "/version" });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { commit: COMMIT, builtAt: BUILT_AT });
    });

    it("is never cached", async () => {
      const res = await app.inject({ method: "GET", url: "/version" });

      assert.equal(res.headers["cache-control"], "no-store");
    });

    it("exposes only the commit and build time", async () => {
      const res = await app.inject({ method: "GET", url: "/version" });

      assert.deepEqual(Object.keys(res.json()).sort(), ["builtAt", "commit"]);
      assert.equal(res.body.includes(RELAY_SECRET), false);
      assert.equal(res.body.includes("mongodb"), false);
    });
  });

  describe("without a bound commit", () => {
    let app: FastifyInstance;
    let cleanup: () => Promise<void>;

    before(async () => {
      const ctx = await createTestApp({ configOverrides: { GIT_COMMIT_SHA: undefined } });
      app = ctx.app;
      cleanup = ctx.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it("reports an unknown commit and no build time instead of failing", async () => {
      const res = await app.inject({ method: "GET", url: "/version" });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { commit: "unknown", builtAt: null });
    });
  });
});

describe("readBuiltAt", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "built-at-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fileWith(name: string, contents: string): URL {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return pathToFileURL(path);
  }

  it("reads the time the Dockerfile writes", () => {
    assert.equal(readBuiltAt(fileWith("valid.txt", `${BUILT_AT}\n`)), BUILT_AT);
  });

  it("returns null when the file is missing", () => {
    assert.equal(readBuiltAt(pathToFileURL(join(dir, "missing.txt"))), null);
  });

  it("returns null for anything other than an ISO-8601 UTC time", () => {
    assert.equal(readBuiltAt(fileWith("garbage.txt", "not a date")), null);
    assert.equal(readBuiltAt(fileWith("offset.txt", "2026-11-08T09:30:00+02:00")), null);
    assert.equal(readBuiltAt(fileWith("impossible.txt", "2026-13-45T25:61:61Z")), null);
  });

  it("returns null for a calendar-invalid day that Date.parse would roll over", () => {
    assert.equal(readBuiltAt(fileWith("feb-30.txt", "2026-02-30T09:30:00Z")), null);
    assert.equal(readBuiltAt(fileWith("apr-31.txt", "2026-04-31T09:30:00Z")), null);
  });

  it("resolves next to the compiled entrypoint", () => {
    assert.equal(getBuiltAtUrl("file:///app/dist/index.js").href, "file:///app/dist/built-at.txt");
  });
});

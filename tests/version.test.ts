import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { getBuiltAtUrl, getCommitUrl, readBuiltAt, readCommit } from "../src/lib/build-info.js";
import { createTestApp } from "./helpers/setup.js";

const COMMIT = "81b811f0123456789abcdef0123456789abcdef0";
const BUILT_COMMIT = "38eac50123456789abcdef0123456789abcdef01";
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

  describe("with a commit from the image build", () => {
    it("reports it ahead of GIT_COMMIT_SHA", async () => {
      const ctx = await createTestApp({ configOverrides: { GIT_COMMIT_SHA: COMMIT }, builtCommit: BUILT_COMMIT });
      try {
        const res = await ctx.app.inject({ method: "GET", url: "/version" });

        assert.equal(res.json().commit, BUILT_COMMIT);
      } finally {
        await ctx.cleanup();
      }
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

describe("readCommit", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "commit-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fileWith(name: string, contents: string): URL {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return pathToFileURL(path);
  }

  it("reads the commit the Dockerfile writes", () => {
    assert.equal(readCommit(fileWith("valid.txt", `${BUILT_COMMIT.toUpperCase()}\n`)), BUILT_COMMIT);
  });

  it("returns null when the build context had no git metadata", () => {
    assert.equal(readCommit(pathToFileURL(join(dir, "missing.txt"))), null);
    assert.equal(readCommit(fileWith("empty.txt", "\n")), null);
    assert.equal(readCommit(fileWith("ref.txt", "ref: refs/heads/master\n")), null);
  });

  it("resolves next to the compiled entrypoint", () => {
    assert.equal(getCommitUrl("file:///app/dist/index.js").href, "file:///app/dist/commit.txt");
  });
});

import assert from "node:assert/strict";
import type { TestContext as NodeTestContext } from "node:test";
import { describe, it } from "node:test";
import { MongoClient } from "mongodb";
import { MongoDbAccessor } from "../../src/db/mongo-db-accessor.js";
import { MongoDbConnector } from "../../src/db/mongo-db-connector.js";
import { InstallScriptService } from "../../src/services/install-script-service.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

type FetchCall = {
  url: string;
  accept: string | null;
};

function createRelease(
  tagName: string,
  publishedAt: string,
  overrides?: Partial<Record<"draft" | "prerelease", boolean>>,
) {
  return {
    tag_name: tagName,
    draft: overrides?.draft ?? false,
    prerelease: overrides?.prerelease ?? false,
    published_at: publishedAt,
  };
}

function createJsonResponse(body: unknown, init?: { status?: number; headers?: HeadersInit }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function createTextResponse(body: string, init?: { status?: number; headers?: HeadersInit }): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: init?.headers,
  });
}

function createFetchMock(t: NodeTestContext, responders: Record<string, Array<() => Response | Promise<Response>>>) {
  const calls: FetchCall[] = [];

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, accept: headers.get("accept") });

    const queue = responders[url];
    assert.ok(queue, `unexpected fetch url: ${url}`);

    const responder = queue.shift();
    assert.ok(responder, `unexpected extra fetch for url: ${url}`);
    return responder();
  });

  return {
    calls,
    assertExhausted() {
      for (const [url, queue] of Object.entries(responders)) {
        assert.equal(queue.length, 0, `expected all queued responses to be used for ${url}`);
      }
    },
  };
}

function releasesUrl(page: number): string {
  return `https://api.github.com/repos/sesori-ai/sesori_apps_monorepo/releases?per_page=100&page=${page}`;
}

function contentsUrl(path: string, tag: string): string {
  return `https://api.github.com/repos/sesori-ai/sesori_apps_monorepo/contents/${path}?ref=${tag}`;
}

function assertOnlyAllowedGithubUrls(calls: FetchCall[]): void {
  for (const call of calls) {
    assert.match(call.url, /^https:\/\/api\.github\.com\/repos\/sesori-ai\/sesori_apps_monorepo\//);
    assert.doesNotMatch(call.url, /\/main(?:$|[/?#])/);
    assert.doesNotMatch(call.url, /download_url/);
    assert.doesNotMatch(call.url, /\/tarball\//);
    assert.doesNotMatch(call.url, /\/zipball\//);
    assert.doesNotMatch(call.url, /\/releases\/latest(?:$|[/?#])/);
  }
}

describe("Install routes", () => {
  function mockMongoHarness(t: { mock: NodeTestContext["mock"] }) {
    const fakeCollection = {} as never;
    const fakeDb = {
      collection: () => fakeCollection,
      dropDatabase: async () => {},
    } as never;

    t.mock.method(MongoClient.prototype, "connect", async function () {
      return this;
    });
    t.mock.method(MongoClient.prototype, "close", async () => {});
    t.mock.method(MongoDbConnector.prototype, "getDb", () => fakeDb);
    t.mock.method(MongoDbAccessor.prototype, "ensureIndexes", async () => {});
  }

  const installScriptService: Pick<InstallScriptService, "getInstallSh" | "getInstallPs1"> = {
    getInstallSh: async () => "#!/bin/sh\necho install\n",
    getInstallPs1: async () => "Write-Output 'install'\n",
  };

  async function createRouteTestApp(t: NodeTestContext): Promise<TestContext> {
    mockMongoHarness(t);
    return createTestApp({ installScriptService: installScriptService as InstallScriptService });
  }

  async function createLiveServiceRouteTestApp(t: NodeTestContext): Promise<TestContext> {
    mockMongoHarness(t);
    return createTestApp({ installScriptService: new InstallScriptService() });
  }

  it("GET /install.sh returns the shell install script as plain text without auth", async (t) => {
    const ctx = await createRouteTestApp(t);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/install.sh",
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"] ?? "", /text\/plain/);
      assert.equal(res.body, "#!/bin/sh\necho install\n");
    } finally {
      await ctx.cleanup();
    }
  });

  it("GET /install.ps1 returns the PowerShell install script as plain text without auth", async (t) => {
    const ctx = await createRouteTestApp(t);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/install.ps1",
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"] ?? "", /text\/plain/);
      assert.equal(res.body, "Write-Output 'install'\n");
    } finally {
      await ctx.cleanup();
    }
  });

  it("GET /install.sh and /install.ps1 stay paired across a refresh when the release tag changes", async (t) => {
    const ctx = await createLiveServiceRouteTestApp(t);
    const tagOne = "bridge-v1.4.0";
    const tagTwo = "bridge-v1.5.0";
    let now = 1_000;
    t.mock.method(Date, "now", () => now);

    const service = new InstallScriptService();
    const fetchMock = createFetchMock(t, {
      [releasesUrl(1)]: [
        () => createJsonResponse([createRelease(tagOne, "2026-02-14T08:30:00.000Z")]),
        () => createJsonResponse([createRelease(tagTwo, "2026-02-15T08:30:00.000Z")]),
      ],
      [contentsUrl("install.sh", tagOne)]: [() => createTextResponse("first-sh")],
      [contentsUrl("install.ps1", tagOne)]: [() => createTextResponse("first-ps1")],
      [contentsUrl("install.sh", tagTwo)]: [() => createTextResponse("second-sh")],
      [contentsUrl("install.ps1", tagTwo)]: [() => createTextResponse("second-ps1")],
    });

    try {
      const firstSh = await ctx.app.inject({ method: "GET", url: "/install.sh" });
      const firstPs1 = await ctx.app.inject({ method: "GET", url: "/install.ps1" });

      assert.equal(firstSh.statusCode, 200);
      assert.equal(firstSh.body, "first-sh");
      assert.equal(firstPs1.statusCode, 200);
      assert.equal(firstPs1.body, "first-ps1");

      now += service.cacheTtlMs;

      const secondSh = await ctx.app.inject({ method: "GET", url: "/install.sh" });
      const secondPs1 = await ctx.app.inject({ method: "GET", url: "/install.ps1" });

      assert.equal(secondSh.statusCode, 200);
      assert.equal(secondSh.body, "second-sh");
      assert.equal(secondPs1.statusCode, 200);
      assert.equal(secondPs1.body, "second-ps1");
      assert.deepEqual(
        fetchMock.calls.map((call) => call.url),
        [
          releasesUrl(1),
          contentsUrl("install.sh", tagOne),
          contentsUrl("install.ps1", tagOne),
          releasesUrl(1),
          contentsUrl("install.sh", tagTwo),
          contentsUrl("install.ps1", tagTwo),
        ],
      );
      assertOnlyAllowedGithubUrls(fetchMock.calls);
      fetchMock.assertExhausted();
    } finally {
      await ctx.cleanup();
    }
  });

  it("GET /install.sh returns 502 bad_gateway json when the cold cache refresh fails", async (t) => {
    const ctx = await createLiveServiceRouteTestApp(t);
    createFetchMock(t, {
      [releasesUrl(1)]: [() => createJsonResponse([], { status: 500 })],
    });

    try {
      const res = await ctx.app.inject({ method: "GET", url: "/install.sh" });

      assert.equal(res.statusCode, 502);
      assert.match(res.headers["content-type"] ?? "", /application\/json/);
      assert.deepEqual(JSON.parse(res.body), { error: "bad_gateway" });
    } finally {
      await ctx.cleanup();
    }
  });
});

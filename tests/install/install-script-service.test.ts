import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import { BadGatewayError } from "../../src/lib/errors.js";
import { InstallScriptService } from "../../src/services/install-script-service.js";

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

function createFetchMock(t: TestContext, responders: Record<string, Array<() => Response | Promise<Response>>>) {
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

function assertContentsAcceptHeaders(calls: FetchCall[], tag: string): void {
  const contentCalls = calls.filter((call) => call.url.includes(`/contents/`) && call.url.includes(`ref=${tag}`));
  assert.ok(contentCalls.length > 0, `expected at least one contents request for ${tag}`);

  for (const call of contentCalls) {
    assert.equal(call.accept, "application/vnd.github.raw+json");
  }
}

describe("InstallScriptService", () => {
  it("keeps install script repository constants hardcoded in the service", () => {
    const service = new InstallScriptService();

    assert.equal(service.repoOwner, "sesori-ai");
    assert.equal(service.repoName, "sesori_apps_monorepo");
    assert.equal(service.installScriptPath, "install.sh");
    assert.equal(service.installPowerShellPath, "install.ps1");
    assert.equal(service.cacheTtlMs, 5 * 60 * 1000);
  });

  it("filters to published bridge releases only", () => {
    const service = new InstallScriptService();

    const release = service.selectLatestRelease([
      createRelease("server-v9.0.0", "2026-03-02T10:00:00.000Z"),
      createRelease("bridge-v1.2.0", "2026-03-03T10:00:00.000Z", { draft: true }),
      createRelease("bridge-v1.3.0-rc.1", "2026-03-04T10:00:00.000Z", { prerelease: true }),
      createRelease("bridge-v0.9.0", "not-a-date"),
      createRelease("bridge-v1.1.0", "2026-03-01T10:00:00.000Z"),
    ]);

    assert.equal(release.tagName, "bridge-v1.1.0");
    assert.equal(release.publishedAt, "2026-03-01T10:00:00.000Z");
  });

  it("selects the newest eligible release by published_at", () => {
    const service = new InstallScriptService();

    const release = service.selectLatestRelease([
      createRelease("bridge-v1.2.0", "2026-02-12T08:30:00.000Z"),
      createRelease("bridge-v1.4.0", "2026-02-14T08:30:00.000Z"),
      createRelease("bridge-v1.3.0", "2026-02-13T08:30:00.000Z"),
    ]);

    assert.equal(release.tagName, "bridge-v1.4.0");
  });

  it("uses descending tag_name as the deterministic tie-breaker", () => {
    const service = new InstallScriptService();

    const release = service.selectLatestRelease([
      createRelease("bridge-v1.9.0", "2026-02-14T08:30:00.000Z"),
      createRelease("bridge-v2.0.0", "2026-02-14T08:30:00.000Z"),
      createRelease("bridge-v1.8.9", "2026-02-14T08:30:00.000Z"),
    ]);

    assert.equal(release.tagName, "bridge-v2.0.0");
  });

  it("throws BadGatewayError when no eligible release exists", () => {
    const service = new InstallScriptService();

    assert.throws(
      () =>
        service.selectLatestRelease([
          createRelease("bridge-v1.0.0", "2026-02-14T08:30:00.000Z", { draft: true }),
          createRelease("web-v1.0.0", "2026-02-14T08:30:00.000Z"),
        ]),
      (error: unknown) => {
        assert.ok(error instanceof BadGatewayError);
        assert.equal(error.debugMessage, "NO_ELIGIBLE_INSTALL_SCRIPT_RELEASE");
        return true;
      },
    );
  });

  it("fetches release pages sequentially and then downloads both scripts from the selected tag", async (t) => {
    const service = new InstallScriptService();
    const tag = "bridge-v1.4.0";
    const fetchMock = createFetchMock(t, {
      [releasesUrl(1)]: [
        () =>
          createJsonResponse([createRelease("bridge-v1.2.0", "2026-02-10T08:30:00.000Z")], {
            headers: {
              link: `<${releasesUrl(2)}>; rel="next", <${releasesUrl(2)}>; rel="last"`,
            },
          }),
      ],
      [releasesUrl(2)]: [() => createJsonResponse([createRelease(tag, "2026-02-14T08:30:00.000Z")])],
      [contentsUrl("install.sh", tag)]: [() => createTextResponse("#!/bin/sh\necho bridge\n")],
      [contentsUrl("install.ps1", tag)]: [() => createTextResponse("Write-Output bridge\n")],
    });

    const installSh = await service.getInstallSh();
    const installPs1 = await service.getInstallPs1();

    assert.equal(installSh, "#!/bin/sh\necho bridge\n");
    assert.equal(installPs1, "Write-Output bridge\n");
    assert.deepEqual(
      fetchMock.calls.map((call) => call.url),
      [releasesUrl(1), releasesUrl(2), contentsUrl("install.sh", tag), contentsUrl("install.ps1", tag)],
    );
    assertContentsAcceptHeaders(fetchMock.calls, tag);
    assertOnlyAllowedGithubUrls(fetchMock.calls);
    fetchMock.assertExhausted();
  });

  it("reuses one atomic cache entry for cache hits across both script getters", async (t) => {
    const service = new InstallScriptService();
    const tag = "bridge-v1.4.0";
    let now = 1_000;
    t.mock.method(Date, "now", () => now);

    const fetchMock = createFetchMock(t, {
      [releasesUrl(1)]: [() => createJsonResponse([createRelease(tag, "2026-02-14T08:30:00.000Z")])],
      [contentsUrl("install.sh", tag)]: [() => createTextResponse("curl -fsSL https://example.test/install.sh | sh")],
      [contentsUrl("install.ps1", tag)]: [() => createTextResponse("irm https://example.test/install.ps1 | iex")],
    });

    const installSh = await service.getInstallSh();
    now += service.cacheTtlMs - 1;
    const installPs1 = await service.getInstallPs1();

    assert.equal(installSh, "curl -fsSL https://example.test/install.sh | sh");
    assert.equal(installPs1, "irm https://example.test/install.ps1 | iex");
    assert.equal(fetchMock.calls.length, 3);
    assertOnlyAllowedGithubUrls(fetchMock.calls);
    fetchMock.assertExhausted();
  });

  it("single-flights concurrent expired-cache refreshes through one shared promise", async (t) => {
    const service = new InstallScriptService();
    const initialTag = "bridge-v1.0.0";
    const refreshedTag = "bridge-v1.1.0";
    let now = 10_000;
    let releasePageTwoResolve!: (value: Response) => void;
    const releasePageTwoPromise = new Promise<Response>((resolve) => {
      releasePageTwoResolve = resolve;
    });
    t.mock.method(Date, "now", () => now);

    const fetchMock = createFetchMock(t, {
      [releasesUrl(1)]: [
        () => createJsonResponse([createRelease(initialTag, "2026-02-10T08:30:00.000Z")]),
        () => createJsonResponse([createRelease(refreshedTag, "2026-02-11T08:30:00.000Z")]),
      ],
      [contentsUrl("install.sh", initialTag)]: [() => createTextResponse("initial-sh")],
      [contentsUrl("install.ps1", initialTag)]: [() => createTextResponse("initial-ps1")],
      [contentsUrl("install.sh", refreshedTag)]: [async () => releasePageTwoPromise],
      [contentsUrl("install.ps1", refreshedTag)]: [() => createTextResponse("refreshed-ps1")],
    });

    await service.getInstallSh();

    now += service.cacheTtlMs;
    const installShPromise = service.getInstallSh();
    const installPs1Promise = service.getInstallPs1();

    assert.equal(fetchMock.calls.filter((call) => call.url === releasesUrl(1)).length, 2);

    releasePageTwoResolve(createTextResponse("refreshed-sh"));

    const [installSh, installPs1] = await Promise.all([installShPromise, installPs1Promise]);

    assert.equal(installSh, "refreshed-sh");
    assert.equal(installPs1, "refreshed-ps1");
    assert.equal(fetchMock.calls.filter((call) => call.url === contentsUrl("install.sh", refreshedTag)).length, 1);
    assert.equal(fetchMock.calls.filter((call) => call.url === contentsUrl("install.ps1", refreshedTag)).length, 1);
    assertOnlyAllowedGithubUrls(fetchMock.calls);
    fetchMock.assertExhausted();
  });

  it("extends the ttl without refetching script bodies when the selected tag is unchanged", async (t) => {
    const service = new InstallScriptService();
    const tag = "bridge-v1.4.0";
    let now = 50_000;
    t.mock.method(Date, "now", () => now);

    const fetchMock = createFetchMock(t, {
      [releasesUrl(1)]: [
        () => createJsonResponse([createRelease(tag, "2026-02-14T08:30:00.000Z")]),
        () => createJsonResponse([createRelease(tag, "2026-02-14T08:30:00.000Z")]),
      ],
      [contentsUrl("install.sh", tag)]: [() => createTextResponse("stable-sh")],
      [contentsUrl("install.ps1", tag)]: [() => createTextResponse("stable-ps1")],
    });

    await service.getInstallSh();

    now += service.cacheTtlMs;
    const installPs1 = await service.getInstallPs1();

    assert.equal(installPs1, "stable-ps1");
    assert.deepEqual(
      fetchMock.calls.map((call) => call.url),
      [releasesUrl(1), contentsUrl("install.sh", tag), contentsUrl("install.ps1", tag), releasesUrl(1)],
    );

    now += service.cacheTtlMs - 1;
    const installSh = await service.getInstallSh();

    assert.equal(installSh, "stable-sh");
    assert.equal(fetchMock.calls.length, 4);
    assertOnlyAllowedGithubUrls(fetchMock.calls);
    fetchMock.assertExhausted();
  });

  it("atomically replaces the cached scripts when the selected tag changes", async (t) => {
    const service = new InstallScriptService();
    const initialTag = "bridge-v1.0.0";
    const updatedTag = "bridge-v1.1.0";
    let now = 75_000;
    t.mock.method(Date, "now", () => now);

    const fetchMock = createFetchMock(t, {
      [releasesUrl(1)]: [
        () => createJsonResponse([createRelease(initialTag, "2026-02-10T08:30:00.000Z")]),
        () => createJsonResponse([createRelease(updatedTag, "2026-02-11T08:30:00.000Z")]),
      ],
      [contentsUrl("install.sh", initialTag)]: [() => createTextResponse("initial-sh")],
      [contentsUrl("install.ps1", initialTag)]: [() => createTextResponse("initial-ps1")],
      [contentsUrl("install.sh", updatedTag)]: [() => createTextResponse("updated-sh")],
      [contentsUrl("install.ps1", updatedTag)]: [() => createTextResponse("updated-ps1")],
    });

    await service.getInstallSh();

    now += service.cacheTtlMs;
    const refreshedInstallPs1 = await service.getInstallPs1();
    const refreshedInstallSh = await service.getInstallSh();

    assert.equal(refreshedInstallPs1, "updated-ps1");
    assert.equal(refreshedInstallSh, "updated-sh");
    assert.deepEqual(
      fetchMock.calls.map((call) => call.url),
      [
        releasesUrl(1),
        contentsUrl("install.sh", initialTag),
        contentsUrl("install.ps1", initialTag),
        releasesUrl(1),
        contentsUrl("install.sh", updatedTag),
        contentsUrl("install.ps1", updatedTag),
      ],
    );
    assertContentsAcceptHeaders(fetchMock.calls, updatedTag);
    assertOnlyAllowedGithubUrls(fetchMock.calls);
    fetchMock.assertExhausted();
  });

  it("throws BadGatewayError when script content is missing during a cold refresh", async (t) => {
    const service = new InstallScriptService();
    const tag = "bridge-v1.4.0";
    const fetchMock = createFetchMock(t, {
      [releasesUrl(1)]: [() => createJsonResponse([createRelease(tag, "2026-02-14T08:30:00.000Z")])],
      [contentsUrl("install.sh", tag)]: [() => createTextResponse("")],
      [contentsUrl("install.ps1", tag)]: [() => createTextResponse("Write-Output bridge\n")],
    });

    await assert.rejects(service.getInstallSh(), (error: unknown) => {
      assert.ok(error instanceof BadGatewayError);
      assert.equal(error.debugMessage, "MISSING_GITHUB_INSTALL_SCRIPT_CONTENT");
      return true;
    });

    assertOnlyAllowedGithubUrls(fetchMock.calls);
    fetchMock.assertExhausted();
  });

  it("keeps stale cached scripts and extends expiry after a warm refresh failure", async (t) => {
    const service = new InstallScriptService();
    const initialTag = "bridge-v2.0.0";
    const updatedTag = "bridge-v2.1.0";
    let now = 100_000;
    t.mock.method(Date, "now", () => now);

    const fetchMock = createFetchMock(t, {
      [releasesUrl(1)]: [
        () => createJsonResponse([createRelease(initialTag, "2026-02-10T08:30:00.000Z")]),
        () => createJsonResponse([createRelease(updatedTag, "2026-02-11T08:30:00.000Z")]),
      ],
      [contentsUrl("install.sh", initialTag)]: [() => createTextResponse("stale-sh")],
      [contentsUrl("install.ps1", initialTag)]: [() => createTextResponse("stale-ps1")],
      [contentsUrl("install.sh", updatedTag)]: [() => createTextResponse("updated-sh")],
      [contentsUrl("install.ps1", updatedTag)]: [() => createTextResponse("", { status: 404 })],
    });

    await service.getInstallSh();

    now += service.cacheTtlMs;
    const staleInstallPs1 = await service.getInstallPs1();

    assert.equal(staleInstallPs1, "stale-ps1");

    now += service.cacheTtlMs - 1;
    const staleInstallSh = await service.getInstallSh();

    assert.equal(staleInstallSh, "stale-sh");
    assertOnlyAllowedGithubUrls(fetchMock.calls);
    fetchMock.assertExhausted();
  });
});

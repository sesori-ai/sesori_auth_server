import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext as NodeTestContext } from "node:test";
import { MongoClient } from "mongodb";
import type { InstallScriptService } from "../../src/services/install-script-service.js";
import { MongoDbAccessor } from "../../src/db/mongo-db-accessor.js";
import { MongoDbConnector } from "../../src/db/mongo-db-connector.js";
import { createTestApp } from "../helpers/setup.js";

describe("Install script service wiring", () => {
  function mockMongoHarness(t: NodeTestContext) {
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

  it("boots with an injected install script service override", async (t) => {
    mockMongoHarness(t);

    const installScriptService = {
      getInstallSh: async () => "#!/bin/sh\necho stub\n",
      getInstallPs1: async () => "Write-Output stub\n",
    } as InstallScriptService;

    const ctx = await createTestApp({ installScriptService });
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/install.sh",
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body, "#!/bin/sh\necho stub\n");
    } finally {
      await ctx.cleanup();
    }
  });

  it("boots with the default real install script service", async (t) => {
    mockMongoHarness(t);
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.includes("/releases?")) {
        return new Response(
          JSON.stringify([
            {
              tag_name: "v1.2.0",
              draft: false,
              prerelease: false,
              published_at: "2026-04-16T08:00:00.000Z",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/contents/install.sh?ref=v1.2.0")) {
        return new Response("#!/bin/sh\necho real\n", { status: 200 });
      }

      if (url.includes("/contents/install.ps1?ref=v1.2.0")) {
        return new Response("Write-Output real\n", { status: 200 });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    });

    const ctx = await createTestApp();
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/install.sh",
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body, "#!/bin/sh\necho real\n");
    } finally {
      await ctx.cleanup();
    }
  });
});

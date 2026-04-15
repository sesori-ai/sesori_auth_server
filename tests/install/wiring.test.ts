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
        url: "/health",
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { status: "ok" });
    } finally {
      await ctx.cleanup();
    }
  });

  it("boots with the default real install script service", async (t) => {
    mockMongoHarness(t);

    const ctx = await createTestApp();
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/health",
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { status: "ok" });
    } finally {
      await ctx.cleanup();
    }
  });
});

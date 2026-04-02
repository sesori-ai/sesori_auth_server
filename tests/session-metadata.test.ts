import { describe, it, before, after, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "./helpers/setup.js";
import { SessionMetadataService } from "../src/services/session-metadata-service.js";
import { QuotaExceededError, InternalServerError } from "../src/lib/errors.js";

describe("POST /sessions/generate-metadata", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("returns 200 with title and branchName for valid auth and body", async () => {
    const user = await ctx.createUser();

    mock.method(SessionMetadataService.prototype, "generateMetadata", async () => ({
      title: "Fix Auth Bug",
      branchName: "fix-auth-bug",
    }));

    const res = await ctx.app.inject({
      method: "POST",
      url: "/sessions/generate-metadata",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ firstMessage: "Fix the authentication bug in the login flow" }),
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{ title: string; branchName: string }>();
    assert.equal(body.title, "Fix Auth Bug");
    assert.equal(body.branchName, "fix-auth-bug");
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/sessions/generate-metadata",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ firstMessage: "Fix the auth bug" }),
    });

    assert.equal(res.statusCode, 401);
  });

  it("returns 400 when firstMessage is an empty string", async () => {
    const user = await ctx.createUser();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/sessions/generate-metadata",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ firstMessage: "" }),
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json<{ error: string }>().error, "bad_request");
  });

  it("returns 429 when the per-minute rate limit is exceeded", async () => {
    const user = await ctx.createUser();

    mock.method(SessionMetadataService.prototype, "generateMetadata", async () => {
      throw new QuotaExceededError({ service: "metadata", debugMessage: "Per-minute limit reached" });
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/sessions/generate-metadata",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ firstMessage: "Fix the auth bug" }),
    });

    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.json(), { error: "quota_exceeded", service: "metadata" });
  });

  it("returns 500 when OpenAI fails", async () => {
    const user = await ctx.createUser();

    mock.method(SessionMetadataService.prototype, "generateMetadata", async () => {
      throw new InternalServerError({ debugMessage: "OpenAI chat completion failed during metadata generation" });
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/sessions/generate-metadata",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ firstMessage: "Fix the auth bug" }),
    });

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: "internal_server_error" });
  });
});

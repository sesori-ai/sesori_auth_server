import { describe, it, before, after, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "./helpers/setup.js";
import { SessionMetadataService } from "../src/services/session-metadata-service.js";
import { ActivationService } from "../src/services/activation-service.js";
import { ActivationStateRepository } from "../src/repositories/activation-state-repo.js";
import { QuotaExceededError, InternalServerError } from "../src/lib/errors.js";

describe("POST /sessions/generate-metadata", () => {
  let ctx: TestContext;
  let activationStateRepo: ActivationStateRepository;

  before(async () => {
    ctx = await createTestApp();
    activationStateRepo = new ActivationStateRepository(ctx.dbAccessor);
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
      worktreeName: "fix-auth-bug",
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
    const body = res.json<{ title: string; branchName: string; worktreeName: string }>();
    assert.equal(body.title, "Fix Auth Bug");
    assert.equal(body.branchName, "fix-auth-bug");
    assert.equal(body.worktreeName, "fix-auth-bug");
    assert.ok((await activationStateRepo.findByUserId(user.userId))?.firstSessionAt);
  });

  it("returns 200 when activation recording fails", async () => {
    const user = await ctx.createUser();
    const recordMock = mock.method(ActivationService.prototype, "recordFirstSession", async () => {
      throw new Error("activation unavailable");
    });
    const warnMock = mock.method(console, "warn", () => {});
    mock.method(SessionMetadataService.prototype, "generateMetadata", async () => ({
      title: "Still Works",
      branchName: "still-works",
      worktreeName: "still-works",
    }));

    const res = await ctx.app.inject({
      method: "POST",
      url: "/sessions/generate-metadata",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ firstMessage: "Keep creating the session" }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(recordMock.mock.callCount(), 1);
    assert.equal(warnMock.mock.callCount(), 1);
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
    assert.ok((await activationStateRepo.findByUserId(user.userId))?.firstSessionAt);
  });
});

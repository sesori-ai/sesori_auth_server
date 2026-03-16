import { describe, it, before, after, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { OpenAIClient } from "../../src/clients/openai-client.js";
import { DatabaseAccessor } from "../../src/db/database-accessor.js";
import { VoiceService } from "../../src/services/voice-service.js";
import { BadGatewayError } from "../../src/lib/errors.js";
import { todayUtcDateKey } from "../../src/repositories/transcription-usage-repo.js";

const BOUNDARY = "----TestBoundary9876543210";

function buildMultipartPayload(args: { fieldName: string; filename: string; content: Buffer; contentType: string }): {
  body: Buffer;
  contentType: string;
} {
  const parts: Buffer[] = [
    Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="${args.fieldName}"; filename="${args.filename}"\r\n` +
        `Content-Type: ${args.contentType}\r\n\r\n`,
    ),
    args.content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ];

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
  };
}

describe("POST /voice/transcribe", () => {
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

  it("returns 401 when called without authentication", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
    });

    assert.equal(res.statusCode, 401);
  });

  it("returns 400 when no file is attached", async () => {
    const user = await ctx.createUser();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({}),
    });

    assert.equal(res.statusCode, 400);
  });

  it("returns 400 when the audio file is empty", async () => {
    const user = await ctx.createUser();
    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "empty.m4a",
      content: Buffer.alloc(0),
      contentType: "audio/m4a",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": contentType,
      },
      payload: body,
    });

    assert.equal(res.statusCode, 400);
  });

  it("returns transcribed text and dailySecondsRemaining on success", async () => {
    const user = await ctx.createUser();

    mock.method(OpenAIClient, "transcribe", async () => ({
      text: "Hello world, this is a test.",
      durationSeconds: 10,
    }));

    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": contentType,
      },
      payload: body,
    });

    assert.equal(res.statusCode, 200);
    const json = res.json();
    assert.equal(json.text, "Hello world, this is a test.");
    assert.equal(typeof json.dailySecondsRemaining, "number");
    assert.equal(json.dailySecondsRemaining, 3590);
  });

  it("passes glossary words in the prompt to OpenAI", async () => {
    const user = await ctx.createUser();

    await ctx.app.inject({
      method: "POST",
      url: "/voice/glossary",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ words: ["Sesori", "XChaCha20"] }),
    });

    let capturedPrompt: string | undefined;
    mock.method(
      OpenAIClient,
      "transcribe",
      async (args: { fileBuffer: Buffer; filename: string; mimetype: string; prompt?: string }) => {
        capturedPrompt = args.prompt;
        return { text: "Sesori uses XChaCha20 encryption.", durationSeconds: 5 };
      },
    );

    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": contentType,
      },
      payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.ok(capturedPrompt, "A prompt should have been passed to OpenAI");
    assert.ok(capturedPrompt.includes("Sesori"), "Prompt should contain glossary word 'Sesori'");
    assert.ok(capturedPrompt.includes("XChaCha20"), "Prompt should contain glossary word 'XChaCha20'");
  });

  it("sends no prompt when user has no glossary entries", async () => {
    const user = await ctx.createUser();

    let capturedPrompt: string | undefined;
    mock.method(
      OpenAIClient,
      "transcribe",
      async (args: { fileBuffer: Buffer; filename: string; mimetype: string; prompt?: string }) => {
        capturedPrompt = args.prompt;
        return { text: "Hello world.", durationSeconds: 3 };
      },
    );

    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": contentType,
      },
      payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(capturedPrompt, undefined, "No prompt should be sent when glossary is empty");
  });

  it("returns 500 when OpenAI returns empty text", async () => {
    const user = await ctx.createUser();

    mock.method(OpenAIClient, "transcribe", async () => ({
      text: "",
      durationSeconds: 0,
    }));

    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": contentType,
      },
      payload: body,
    });

    assert.equal(res.statusCode, 500);
  });

  it("preserves original status code when service throws an ApiError subclass", async () => {
    const user = await ctx.createUser();

    mock.method(VoiceService, "transcribe", async () => {
      throw new BadGatewayError({ debugMessage: "Upstream provider unavailable" });
    });

    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": contentType,
      },
      payload: body,
    });

    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), { error: "bad_gateway" });
  });

  it("returns 500 when OpenAI throws an error", async () => {
    const user = await ctx.createUser();

    mock.method(OpenAIClient, "transcribe", async () => {
      throw new Error("OpenAI API rate limit exceeded");
    });

    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": contentType,
      },
      payload: body,
    });

    assert.equal(res.statusCode, 500);
  });

  it("returns 429 when daily transcription quota is exceeded", async () => {
    const user = await ctx.createUser();
    const userId = new ObjectId(user.userId);

    await DatabaseAccessor.transcriptionUsage().insertOne({
      _id: new ObjectId(),
      userId,
      date: todayUtcDateKey(),
      usedSeconds: 3600,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mock.method(OpenAIClient, "transcribe", async () => ({
      text: "Should not reach here.",
      durationSeconds: 5,
    }));

    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": contentType,
      },
      payload: body,
    });

    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.json(), { error: "quota_exceeded" });
  });

  it("tracks usage in the database after successful transcription", async () => {
    const user = await ctx.createUser();
    const userId = new ObjectId(user.userId);

    mock.method(OpenAIClient, "transcribe", async () => ({
      text: "Tracked transcription.",
      durationSeconds: 42.5,
    }));

    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": contentType,
      },
      payload: body,
    });

    assert.equal(res.statusCode, 200);

    const usageDoc = await DatabaseAccessor.transcriptionUsage().findOne({
      userId,
      date: todayUtcDateKey(),
    });

    assert.ok(usageDoc, "Usage document should exist after transcription");
    assert.equal(usageDoc.usedSeconds, 42.5);
  });

  it("accumulates usage across multiple transcriptions", async () => {
    const user = await ctx.createUser();
    const userId = new ObjectId(user.userId);

    mock.method(OpenAIClient, "transcribe", async () => ({
      text: "First transcription.",
      durationSeconds: 100,
    }));

    const payload = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
    });

    const headers = {
      authorization: `Bearer ${user.accessToken}`,
      "content-type": payload.contentType,
    };

    const res1 = await ctx.app.inject({ method: "POST", url: "/voice/transcribe", headers, payload: payload.body });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.json().dailySecondsRemaining, 3500);

    const res2 = await ctx.app.inject({ method: "POST", url: "/voice/transcribe", headers, payload: payload.body });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.json().dailySecondsRemaining, 3400);

    const usageDoc = await DatabaseAccessor.transcriptionUsage().findOne({
      userId,
      date: todayUtcDateKey(),
    });
    assert.ok(usageDoc);
    assert.equal(usageDoc.usedSeconds, 200);
  });

  it("allows transcription when under quota but near limit", async () => {
    const user = await ctx.createUser();
    const userId = new ObjectId(user.userId);

    await DatabaseAccessor.transcriptionUsage().insertOne({
      _id: new ObjectId(),
      userId,
      date: todayUtcDateKey(),
      usedSeconds: 3590,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mock.method(OpenAIClient, "transcribe", async () => ({
      text: "Allowed near limit.",
      durationSeconds: 30,
    }));

    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": contentType,
      },
      payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().dailySecondsRemaining, 0);
  });
});

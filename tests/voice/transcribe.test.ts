import { describe, it, before, after, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { OpenAIClient } from "../../src/clients/openai-client.js";

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

  it("returns transcribed text on success", async () => {
    const user = await ctx.createUser();

    mock.method(OpenAIClient, "transcribe", async () => "Hello world, this is a test.");

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
    assert.deepEqual(res.json(), { text: "Hello world, this is a test." });
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
      async (args: { fileBuffer: Buffer; filename: string; prompt?: string }) => {
        capturedPrompt = args.prompt;
        return "Sesori uses XChaCha20 encryption.";
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
      async (args: { fileBuffer: Buffer; filename: string; prompt?: string }) => {
        capturedPrompt = args.prompt;
        return "Hello world.";
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

    mock.method(OpenAIClient, "transcribe", async () => "");

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
});

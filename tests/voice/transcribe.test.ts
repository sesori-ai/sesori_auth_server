import { describe, it, before, after, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { OpenAIClient } from "../../src/clients/openai-client.js";
import { VoiceService } from "../../src/services/voice-service.js";
import { BadGatewayError } from "../../src/lib/errors.js";
import { todayUtcDateKey, DailyUsageRepository } from "../../src/repositories/daily-usage-repo.js";
import type { DailyUsage } from "../../src/models/documents.js";
import { MongoDbDatabase, AuthDbCollection } from "../../src/types/mongo.js";

const BOUNDARY = "----TestBoundary9876543210";
const PROJECT_KEY = `prj_v1_${"A".repeat(43)}`;
const OTHER_PROJECT_KEY = `prj_v1_${"B".repeat(43)}`;

function buildMultipartPayload(args: {
  fieldName: string;
  filename: string;
  content: Buffer;
  contentType: string;
  fields?: { name: string; value: string }[];
  fieldsFirst?: boolean;
}): {
  body: Buffer;
  contentType: string;
} {
  const fieldParts = (args.fields ?? []).map((field) =>
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`),
  );
  const filePart = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="${args.fieldName}"; filename="${args.filename}"\r\n` +
        `Content-Type: ${args.contentType}\r\n\r\n`,
    ),
    args.content,
    Buffer.from("\r\n"),
  ]);
  const ordered = args.fieldsFirst ? [...fieldParts, filePart] : [filePart, ...fieldParts];

  return {
    body: Buffer.concat([...ordered, Buffer.from(`--${BOUNDARY}--\r\n`)]),
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

  it("returns 400 when the audio MIME type is not supported", async () => {
    const user = await ctx.createUser();
    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "file.mp4",
      content: Buffer.from("fake-video-data"),
      contentType: "video/mp4",
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

  it("preserves the framework 413 when the audio file exceeds the size limit", async () => {
    const user = await ctx.createUser();
    mock.method(OpenAIClient.prototype, "transcribe", async () => ({ text: "unused", durationSeconds: 1 }));

    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "too-large.m4a",
      content: Buffer.alloc(25 * 1024 * 1024 + 1024, 1),
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

    assert.equal(res.statusCode, 413);
  });

  it("rejects an unknown __proto__ multipart field instead of silently dropping it", async () => {
    const user = await ctx.createUser();
    mock.method(OpenAIClient.prototype, "transcribe", async () => ({ text: "unused", durationSeconds: 1 }));

    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
      fields: [{ name: "__proto__", value: "polluted" }],
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
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("rejects an unexpected extra file part without stalling the request", async () => {
    const user = await ctx.createUser();
    mock.method(OpenAIClient.prototype, "transcribe", async () => ({ text: "unused", durationSeconds: 1 }));

    const filePart = (name: string) =>
      Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="f.m4a"\r\n` +
            `Content-Type: audio/m4a\r\n\r\n`,
        ),
        Buffer.from("fake-audio-data-for-testing"),
        Buffer.from("\r\n"),
      ]);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: Buffer.concat([filePart("audio"), filePart("extra"), Buffer.from(`--${BOUNDARY}--\r\n`)]),
    });

    assert.equal(res.statusCode, 400, "an unexpected extra file part must be a bounded 400");
  });

  it("returns transcribed text and dailySecondsRemaining on success", async () => {
    const user = await ctx.createUser();

    mock.method(OpenAIClient.prototype, "transcribe", async () => ({
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
    // Default limit is 3600s; 10s used → 3590s remaining.
    assert.equal(json.dailySecondsRemaining, 3590);
  });

  async function seedGlossary(accessToken: string, projectKey: string, words: string[]): Promise<void> {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/glossary",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ projectKey, words }),
    });
    assert.equal(res.statusCode, 200);
  }

  function capturePrompt(text: string, durationSeconds: number): { read: () => string | undefined } {
    let capturedPrompt: string | undefined;
    mock.method(
      OpenAIClient.prototype,
      "transcribe",
      async (args: { fileBuffer: Buffer; filename: string; mimetype: string; prompt?: string }) => {
        capturedPrompt = args.prompt;
        return { text, durationSeconds };
      },
    );
    return { read: () => capturedPrompt };
  }

  it("passes the requested project's glossary words in the prompt to OpenAI", async () => {
    const user = await ctx.createUser();
    await seedGlossary(user.accessToken, PROJECT_KEY, ["Sesori", "XChaCha20"]);
    await seedGlossary(user.accessToken, OTHER_PROJECT_KEY, ["OtherProjectTerm"]);

    const prompt = capturePrompt("Sesori uses XChaCha20 encryption.", 5);
    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
      fields: [{ name: "projectKey", value: PROJECT_KEY }],
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
    const capturedPrompt = prompt.read();
    assert.ok(capturedPrompt, "A prompt should have been passed to OpenAI");
    assert.ok(capturedPrompt.includes("Sesori"), "Prompt should contain glossary word 'Sesori'");
    assert.ok(capturedPrompt.includes("XChaCha20"), "Prompt should contain glossary word 'XChaCha20'");
    assert.ok(!capturedPrompt.includes("OtherProjectTerm"), "Prompt must not leak another project's terms");
  });

  it("accepts the projectKey field before the audio part", async () => {
    const user = await ctx.createUser();
    await seedGlossary(user.accessToken, PROJECT_KEY, ["Sesori"]);

    const prompt = capturePrompt("Sesori.", 2);
    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
      fields: [{ name: "projectKey", value: PROJECT_KEY }],
      fieldsFirst: true,
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
    assert.ok(prompt.read()?.includes("Sesori"));
  });

  it("sends no prompt when the requested project has no glossary entries", async () => {
    const user = await ctx.createUser();

    const prompt = capturePrompt("Hello world.", 3);
    const { body, contentType } = buildMultipartPayload({
      fieldName: "audio",
      filename: "test.m4a",
      content: Buffer.from("fake-audio-data-for-testing"),
      contentType: "audio/m4a",
      fields: [{ name: "projectKey", value: PROJECT_KEY }],
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
    assert.equal(prompt.read(), undefined, "No prompt should be sent when the project glossary is empty");
  });

  it("sends no prompt when a legacy client omits projectKey even if other projects have terms", async () => {
    const user = await ctx.createUser();
    await seedGlossary(user.accessToken, PROJECT_KEY, ["Sesori"]);

    const prompt = capturePrompt("Hello world.", 3);
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
    assert.equal(prompt.read(), undefined, "Omitted project context must never fall back to a global glossary");
  });

  it("returns 400 for malformed, duplicated, or unknown multipart text fields", async () => {
    const user = await ctx.createUser();
    mock.method(OpenAIClient.prototype, "transcribe", async () => ({ text: "unused", durationSeconds: 1 }));

    const invalidFieldSets = [
      [{ name: "projectKey", value: "prj_v1_short" }],
      [
        { name: "projectKey", value: PROJECT_KEY },
        { name: "projectKey", value: OTHER_PROJECT_KEY },
      ],
      [{ name: "unexpected", value: "value" }],
    ];

    for (const fields of invalidFieldSets) {
      const { body, contentType } = buildMultipartPayload({
        fieldName: "audio",
        filename: "test.m4a",
        content: Buffer.from("fake-audio-data-for-testing"),
        contentType: "audio/m4a",
        fields,
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

      assert.equal(res.statusCode, 400, JSON.stringify(fields));
    }
  });

  it("returns 500 when OpenAI returns empty text", async () => {
    const user = await ctx.createUser();

    mock.method(OpenAIClient.prototype, "transcribe", async () => ({
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

    mock.method(VoiceService.prototype, "transcribe", async () => {
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

    mock.method(OpenAIClient.prototype, "transcribe", async () => {
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

    await ctx.dbAccessor.getCollection<DailyUsage>(MongoDbDatabase.Auth, AuthDbCollection.DailyUsage).insertOne({
      _id: new ObjectId(),
      userId,
      date: todayUtcDateKey(),
      transcriptionSeconds: 3600,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mock.method(OpenAIClient.prototype, "transcribe", async () => ({
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
    assert.deepEqual(res.json(), { error: "quota_exceeded", service: "transcription" });
  });

  it("returns 200 even if usage recording fails (soft-fail)", async () => {
    const user = await ctx.createUser();

    mock.method(OpenAIClient.prototype, "transcribe", async () => ({
      text: "Transcription succeeded.",
      durationSeconds: 15,
    }));

    // Patch the instance method on the prototype. Note: this verifies the soft-fail
    // path in VoiceService — if incrementTranscriptionSeconds throws, the route still
    // returns 200 with an estimated remaining value (limit - usedSeconds - durationSeconds).
    mock.method(DailyUsageRepository.prototype, "incrementTranscriptionSeconds", async () => {
      throw new Error("MongoDB connection lost");
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

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().text, "Transcription succeeded.");
    // Fallback: limit(3600) - usedSeconds(0) - durationSeconds(15) = 3585.
    assert.equal(res.json().dailySecondsRemaining, 3585);
  });

  it("tracks usage in the database after successful transcription", async () => {
    const user = await ctx.createUser();
    const userId = new ObjectId(user.userId);

    mock.method(OpenAIClient.prototype, "transcribe", async () => ({
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

    const usageDoc = await ctx.dbAccessor
      .getCollection<DailyUsage>(MongoDbDatabase.Auth, AuthDbCollection.DailyUsage)
      .findOne({
        userId,
        date: todayUtcDateKey(),
      });

    assert.ok(usageDoc, "Usage document should exist after transcription");
    assert.equal(usageDoc.transcriptionSeconds, 42.5);
    assert.equal(usageDoc.date, todayUtcDateKey(), "Date field should match today's UTC key");
  });

  it("accumulates usage across multiple transcriptions", async () => {
    const user = await ctx.createUser();
    const userId = new ObjectId(user.userId);

    mock.method(OpenAIClient.prototype, "transcribe", async () => ({
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

    const usageDoc = await ctx.dbAccessor
      .getCollection<DailyUsage>(MongoDbDatabase.Auth, AuthDbCollection.DailyUsage)
      .findOne({
        userId,
        date: todayUtcDateKey(),
      });
    assert.ok(usageDoc);
    assert.equal(usageDoc.transcriptionSeconds, 200);
  });

  it("allows transcription when under quota but near limit", async () => {
    const user = await ctx.createUser();
    const userId = new ObjectId(user.userId);

    await ctx.dbAccessor.getCollection<DailyUsage>(MongoDbDatabase.Auth, AuthDbCollection.DailyUsage).insertOne({
      _id: new ObjectId(),
      userId,
      date: todayUtcDateKey(),
      transcriptionSeconds: 3590,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mock.method(OpenAIClient.prototype, "transcribe", async () => ({
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

  it("allows transcription when usedSeconds is just below the limit (>= boundary)", async () => {
    const user = await ctx.createUser();
    const userId = new ObjectId(user.userId);

    // Pre-populate with 3599s: usedSeconds(3599) < limit(3600) → pre-check passes.
    // After 1s transcription: newTotal = 3600, remainingSeconds = 0.
    await ctx.dbAccessor.getCollection<DailyUsage>(MongoDbDatabase.Auth, AuthDbCollection.DailyUsage).insertOne({
      _id: new ObjectId(),
      userId,
      date: todayUtcDateKey(),
      transcriptionSeconds: 3599,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mock.method(OpenAIClient.prototype, "transcribe", async () => ({
      text: "Boundary transcription.",
      durationSeconds: 1,
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

    // usedSeconds(3599) < limit(3600): pre-check passes (check is >=, not >).
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().dailySecondsRemaining, 0);
  });
});

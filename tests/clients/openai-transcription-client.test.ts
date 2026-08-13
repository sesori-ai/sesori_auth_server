import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Transcriptions } from "openai/resources/audio/transcriptions";
import { OpenAIClient } from "../../src/clients/openai-client.js";
import { TranscriptionFailure, TranscriptionFailureReason } from "../../src/types/transcription.js";

type RequestOverrides = {
  readonly audio?: Buffer;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly terms?: string[];
  readonly signal?: AbortSignal;
};

function request(overrides: RequestOverrides = {}) {
  return {
    audio: overrides.audio ?? Buffer.from("fake-audio"),
    filename: overrides.filename ?? "voice.m4a",
    mimeType: overrides.mimeType ?? "audio/m4a",
    terms: overrides.terms ?? [],
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  };
}

function createPcmWav(durationSeconds: number): Buffer {
  const sampleRate = 8_000;
  const bytesPerSample = 2;
  const dataSize = Math.round(durationSeconds * sampleRate) * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);

  return wav;
}

async function expectReason(run: () => Promise<unknown>, reason: TranscriptionFailureReason): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof TranscriptionFailure, `expected TranscriptionFailure, got ${String(error)}`);
    assert.equal(error.reason, reason);
    return true;
  });
}

describe("OpenAIClient as an AsyncTranscriptionClient", () => {
  function createClient(): OpenAIClient {
    return new OpenAIClient({ apiKey: "test-key", model: "whisper-1" });
  }

  it("returns metadata duration for a valid sub-second WAV", async (t) => {
    t.mock.method(Transcriptions.prototype, "create", async () => ({ text: "hello from openai" }));

    const result = await createClient().transcribe(
      request({
        audio: createPcmWav(0.2),
        filename: "voice.wav",
        mimeType: "audio/wav",
      }),
    );

    assert.equal(result.text, "hello from openai");
    assert.ok(Math.abs(result.durationSeconds - 0.2) < 0.001);
  });

  it("falls back to a positive whole estimate when metadata cannot be parsed", async (t) => {
    t.mock.method(Transcriptions.prototype, "create", async () => ({ text: "hello from openai" }));

    const result = await createClient().transcribe(request());

    assert.equal(result.durationSeconds, 1);
  });

  it("renders glossary terms through the shared prompt format", async (t) => {
    let captured: { prompt?: string } | undefined;
    t.mock.method(Transcriptions.prototype, "create", async (body: { prompt?: string }) => {
      captured = body;
      return { text: "ok" };
    });

    await createClient().transcribe(request({ terms: ["Sesori", "HKDF"] }));

    assert.equal(captured?.prompt, "The following terms may appear in the audio: Sesori, HKDF.");
  });

  it("sends no prompt when the request carries no terms", async (t) => {
    let captured: { prompt?: string } | undefined;
    t.mock.method(Transcriptions.prototype, "create", async (body: { prompt?: string }) => {
      captured = body;
      return { text: "ok" };
    });

    await createClient().transcribe(request({ terms: [] }));

    assert.equal(captured?.prompt, undefined);
  });

  it("maps caller cancellation to cancelled", async (t) => {
    const controller = new AbortController();
    t.mock.method(Transcriptions.prototype, "create", async () => {
      controller.abort();
      throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
    });

    await expectReason(
      () => createClient().transcribe(request({ signal: controller.signal })),
      TranscriptionFailureReason.Cancelled,
    );
  });

  it("collapses every non-cancellation provider failure to internal", async (t) => {
    let thrown: unknown = new Error("placeholder");
    t.mock.method(Transcriptions.prototype, "create", async () => {
      throw thrown;
    });

    for (const candidate of [
      Object.assign(new Error("rate limited"), { status: 429 }),
      Object.assign(new Error("server error"), { status: 500 }),
      Object.assign(new Error("bad audio"), { status: 400 }),
      new Error("network down"),
    ]) {
      thrown = candidate;
      await expectReason(() => createClient().transcribe(request()), TranscriptionFailureReason.Internal);
    }
  });

  it("never leaks a raw provider message through the thrown failure", async (t) => {
    const secret = "openai-internal-detail-should-not-escape";
    t.mock.method(Transcriptions.prototype, "create", async () => {
      throw Object.assign(new Error(secret), { status: 500 });
    });

    await assert.rejects(
      () => createClient().transcribe(request()),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptionFailure);
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
  });
});

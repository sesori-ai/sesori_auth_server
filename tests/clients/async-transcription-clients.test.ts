import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SonioxTranscriptionClient, type SonioxAsyncSdk } from "../../src/clients/soniox-transcription-client.js";
import { TranscriptionFailure, TranscriptionFailureReason } from "../../src/types/transcription.js";

type Call = { name: string; id?: string };

function createFakeSdk(
  overrides: Partial<{
    upload: () => Promise<unknown>;
    create: () => Promise<unknown>;
    wait: () => Promise<unknown>;
    getTranscript: () => Promise<unknown>;
    deleteFile: () => Promise<void>;
    deleteTranscription: () => Promise<void>;
  }> = {},
): { sdk: SonioxAsyncSdk; calls: Call[] } {
  const calls: Call[] = [];

  const sdk: SonioxAsyncSdk = {
    files: {
      async upload() {
        calls.push({ name: "files.upload" });
        return overrides.upload ? overrides.upload() : { id: "file_1" };
      },
      async delete(fileId: string) {
        calls.push({ name: "files.delete", id: fileId });
        if (overrides.deleteFile) {
          await overrides.deleteFile();
        }
      },
    },
    stt: {
      async create() {
        calls.push({ name: "stt.create" });
        // The SDK's create() returns a job in a non-terminal status; a
        // "completed" fixture here would not match the provider contract.
        return overrides.create ? overrides.create() : { id: "tr_1", status: "queued" };
      },
      async wait() {
        calls.push({ name: "stt.wait" });
        return overrides.wait ? overrides.wait() : { id: "tr_1", status: "completed", audio_duration_ms: 4200 };
      },
      async getTranscript() {
        calls.push({ name: "stt.getTranscript" });
        return overrides.getTranscript ? overrides.getTranscript() : { text: "hello world" };
      },
      async delete(id: string) {
        calls.push({ name: "stt.delete", id });
        if (overrides.deleteTranscription) {
          await overrides.deleteTranscription();
        }
      },
    },
  };

  return { sdk, calls };
}

function createClient(sdk: SonioxAsyncSdk): SonioxTranscriptionClient {
  return new SonioxTranscriptionClient({
    sdk,
    model: "stt-async-v5",
    timeoutMs: 5_000,
    cleanupTimeoutMs: 1_000,
  });
}

function request(overrides: Partial<{ terms: string[]; signal: AbortSignal }> = {}) {
  return {
    audio: Buffer.from("fake-audio"),
    filename: "voice.m4a",
    mimeType: "audio/m4a",
    terms: overrides.terms ?? [],
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  };
}

async function expectReason(run: () => Promise<unknown>, reason: TranscriptionFailureReason): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof TranscriptionFailure, `expected TranscriptionFailure, got ${String(error)}`);
    assert.equal(error.reason, reason);
    return true;
  });
}

describe("SonioxTranscriptionClient", () => {
  let fake: ReturnType<typeof createFakeSdk>;

  beforeEach(() => {
    fake = createFakeSdk();
  });

  it("returns transcript text and billable seconds on success", async () => {
    const result = await createClient(fake.sdk).transcribe(request());

    assert.deepEqual(result, { text: "hello world", durationSeconds: 5 });
  });

  it("accepts a queued job from create and settles it through wait", async () => {
    const staged = createFakeSdk({
      create: async () => ({ id: "tr_queued", status: "queued" }),
      wait: async () => ({ id: "tr_queued", status: "completed", audio_duration_ms: 1200 }),
    });

    const result = await createClient(staged.sdk).transcribe(request());

    assert.deepEqual(result, { text: "hello world", durationSeconds: 2 });
    assert.deepEqual(
      staged.calls.map((call) => call.name),
      ["files.upload", "stt.create", "stt.wait", "stt.getTranscript", "stt.delete", "files.delete"],
    );
  });

  it("deletes a created job even when the wait fails, so no transcription is stranded", async () => {
    const failing = createFakeSdk({
      create: async () => ({ id: "tr_queued", status: "processing" }),
      wait: async () => {
        throw Object.assign(new Error("still running"), { statusCode: 500 });
      },
    });

    await expectReason(() => createClient(failing.sdk).transcribe(request()), TranscriptionFailureReason.Unavailable);

    const deletes = failing.calls.filter((call) => call.name.endsWith(".delete"));
    assert.deepEqual(
      deletes.map((call) => call.name),
      ["stt.delete", "files.delete"],
    );
    assert.equal(deletes[0].id, "tr_queued");
  });

  it("deletes the transcription before the file after success", async () => {
    await createClient(fake.sdk).transcribe(request());

    const cleanup = fake.calls.filter((call) => call.name.endsWith(".delete")).map((call) => call.name);
    assert.deepEqual(cleanup, ["stt.delete", "files.delete"]);
  });

  it("sends glossary terms as context only when terms exist", async () => {
    let captured: unknown;
    const sdk = createFakeSdk().sdk;
    sdk.stt.create = async (options) => {
      captured = options;
      return { id: "tr_1", status: "queued" };
    };

    await createClient(sdk).transcribe(request({ terms: ["Sesori", "HKDF"] }));
    assert.deepEqual((captured as { context?: unknown }).context, { terms: ["Sesori", "HKDF"] });

    await createClient(sdk).transcribe(request({ terms: [] }));
    assert.equal((captured as { context?: unknown }).context, undefined);
  });

  it("cleans up provider resources even when the transcript fetch fails", async () => {
    const failing = createFakeSdk({
      getTranscript: async () => {
        throw Object.assign(new Error("boom"), { statusCode: 500 });
      },
    });

    await expectReason(() => createClient(failing.sdk).transcribe(request()), TranscriptionFailureReason.Unavailable);

    const cleanup = failing.calls.filter((call) => call.name.endsWith(".delete")).map((call) => call.name);
    assert.deepEqual(cleanup, ["stt.delete", "files.delete"]);
  });

  it("does not delete a transcription that was never created", async () => {
    const failing = createFakeSdk({
      upload: async () => {
        throw Object.assign(new Error("nope"), { statusCode: 503 });
      },
    });

    await expectReason(() => createClient(failing.sdk).transcribe(request()), TranscriptionFailureReason.Unavailable);
    assert.deepEqual(
      failing.calls.map((call) => call.name),
      ["files.upload"],
    );
  });

  it("keeps a valid transcript when cleanup fails", async () => {
    const failing = createFakeSdk({
      deleteTranscription: async () => {
        throw new Error("cleanup exploded");
      },
      deleteFile: async () => {
        throw new Error("cleanup exploded");
      },
    });

    const result = await createClient(failing.sdk).transcribe(request());
    assert.equal(result.text, "hello world");
  });

  it("maps a provider error status to provider_rejected", async () => {
    const failing = createFakeSdk({
      wait: async () => ({ id: "tr_1", status: "error", error_type: "bad_audio" }),
    });

    await expectReason(
      () => createClient(failing.sdk).transcribe(request()),
      TranscriptionFailureReason.ProviderRejected,
    );
  });

  it("maps a malformed transcript to malformed_output", async () => {
    const failing = createFakeSdk({ getTranscript: async () => ({ text: 42 }) });

    await expectReason(
      () => createClient(failing.sdk).transcribe(request()),
      TranscriptionFailureReason.MalformedOutput,
    );
  });

  it("treats a missing duration as malformed rather than a free request", async () => {
    const failing = createFakeSdk({ wait: async () => ({ id: "tr_1", status: "completed" }) });

    await expectReason(
      () => createClient(failing.sdk).transcribe(request()),
      TranscriptionFailureReason.MalformedOutput,
    );
  });

  it("maps caller cancellation to cancelled using the SDK's real abort shape", async () => {
    const controller = new AbortController();
    const failing = createFakeSdk({
      upload: async () => {
        controller.abort();
        // The SDK reports aborts as SonioxHttpError/code "aborted", never as a
        // DOM AbortError, so the fixture must use that shape.
        throw Object.assign(new Error("Request was aborted"), {
          name: "SonioxHttpError",
          code: "aborted",
        });
      },
    });

    await expectReason(
      () => createClient(failing.sdk).transcribe(request({ signal: controller.signal })),
      TranscriptionFailureReason.Cancelled,
    );
  });

  it("maps its own expired budget to timeout rather than a generic outage", async () => {
    const failing = createFakeSdk({
      wait: async () => {
        // Mirrors the SDK's polling-loop abort once our timeout signal fires.
        throw new Error("Transcription wait aborted");
      },
    });
    // Let the client's own budget expire before the SDK call rejects.
    failing.sdk.stt.wait = async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("Transcription wait aborted");
    };
    const client = new SonioxTranscriptionClient({
      sdk: failing.sdk,
      model: "stt-async-v5",
      timeoutMs: 5,
      cleanupTimeoutMs: 1_000,
    });

    await expectReason(() => client.transcribe(request()), TranscriptionFailureReason.Timeout);
  });

  it("maps provider capacity rejection to capacity", async () => {
    const failing = createFakeSdk({
      create: async () => {
        throw Object.assign(new Error("slow down"), { statusCode: 429 });
      },
    });

    await expectReason(() => createClient(failing.sdk).transcribe(request()), TranscriptionFailureReason.Capacity);
  });

  it("never leaks a raw provider message through the thrown failure", async () => {
    const secret = "provider-internal-detail-should-not-escape";
    const failing = createFakeSdk({
      create: async () => {
        throw Object.assign(new Error(secret), { statusCode: 500 });
      },
    });

    await assert.rejects(
      () => createClient(failing.sdk).transcribe(request()),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptionFailure);
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
  });
});

import http from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "../helpers/setup.js";
import type { AsyncTranscriptionClient } from "../../src/clients/async-transcription-client.js";
import {
  TranscriptionFailure,
  TranscriptionFailureReason,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "../../src/types/transcription.js";

const BOUNDARY = "----TestBoundaryTranscribeDisconnect";

class AlreadyDisconnectedTranscriptionClient implements AsyncTranscriptionClient {
  readonly called: Promise<void>;
  #resolveCalled: () => void = () => {};
  signal: AbortSignal | null = null;

  constructor() {
    this.called = new Promise((resolve) => {
      this.#resolveCalled = resolve;
    });
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    this.signal = request.signal ?? null;
    this.#resolveCalled();
    throw new TranscriptionFailure(TranscriptionFailureReason.Cancelled);
  }
}

function buildMultipartPayload(): { body: Buffer; contentType: string } {
  const body = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="audio"; filename="test.m4a"\r\n' +
        "Content-Type: audio/m4a\r\n\r\n",
    ),
    Buffer.from("fake-audio-data-for-testing"),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);

  return { body, contentType: `multipart/form-data; boundary=${BOUNDARY}` };
}

describe("POST /voice/transcribe client disconnect", () => {
  it("passes an already-aborted signal to the transcription client when the caller disconnects after upload", async () => {
    const transcriptionClient = new AlreadyDisconnectedTranscriptionClient();
    const ctx = await createTestApp({ asyncTranscriptionClient: transcriptionClient });

    try {
      const user = await ctx.createUser();
      const { body, contentType } = buildMultipartPayload();
      const address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
      const url = new URL("/voice/transcribe", address);
      let receivedResponse = false;

      const requestClosed = new Promise<void>((resolve) => {
        const request = http.request(
          url,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${user.accessToken}`,
              "content-length": body.length,
              "content-type": contentType,
            },
          },
          (response) => {
            receivedResponse = true;
            response.resume();
            response.on("end", resolve);
          },
        );
        request.on("error", resolve);
        request.end(body, () => {
          request.destroy();
        });
      });

      await transcriptionClient.called;
      await requestClosed;

      assert.equal(transcriptionClient.signal?.aborted, true);
      assert.equal(receivedResponse, false);
    } finally {
      await ctx.cleanup();
    }
  });
});

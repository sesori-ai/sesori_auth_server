import type { AsyncTranscriptionClient } from "./async-transcription-client.js";
import {
  parseCreatedTranscriptionId,
  parseTranscription,
  parseTranscriptText,
  parseUploadedFileId,
  readProviderRetryAfterSeconds,
  toBillableSeconds,
  toFailureReason,
} from "../api/soniox-transcription-api.js";
import { safeErrorType } from "../lib/errors.js";
import {
  TranscriptionFailure,
  TranscriptionFailureReason,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "../types/transcription.js";

/**
 * The narrow slice of `@soniox/node` this client uses. Declaring it structurally
 * keeps the SDK out of the test graph: unit tests inject a fake implementing
 * only these members.
 */
export type SonioxAsyncSdk = {
  files: {
    upload(file: Buffer, options?: { filename?: string; signal?: AbortSignal }): Promise<unknown>;
    delete(fileId: string, signal?: AbortSignal): Promise<void>;
  };
  stt: {
    create(options: SonioxCreateOptions, signal?: AbortSignal): Promise<unknown>;
    wait(id: string, options?: { signal?: AbortSignal }): Promise<unknown>;
    getTranscript(id: string, signal?: AbortSignal): Promise<unknown>;
    delete(id: string, signal?: AbortSignal): Promise<void>;
  };
};

type SonioxCreateOptions = {
  model: string;
  file_id: string;
  language_hints?: string[];
  context?: { terms?: string[] };
};

export class SonioxTranscriptionClient implements AsyncTranscriptionClient {
  readonly #sdk: SonioxAsyncSdk;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #cleanupTimeoutMs: number;

  constructor(deps: { sdk: SonioxAsyncSdk; model: string; timeoutMs: number; cleanupTimeoutMs: number }) {
    this.#sdk = deps.sdk;
    this.#model = deps.model;
    this.#timeoutMs = deps.timeoutMs;
    this.#cleanupTimeoutMs = deps.cleanupTimeoutMs;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    // One bounded signal covers upload, processing, and transcript fetch.
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let fileId: string | null = null;
    let transcriptionId: string | null = null;
    let createAttempted = false;

    try {
      fileId = parseUploadedFileId(await this.#sdk.files.upload(request.audio, { filename: request.filename, signal }));

      // Marked before the call, not after: if create times out or returns an
      // unparseable body, the provider may still have accepted the job. Cleanup
      // has to assume a job it cannot name exists.
      createAttempted = true;

      // Job creation returns a non-terminal status; only its ID is meaningful
      // here. Record it immediately so cleanup can delete the job even if the
      // wait or transcript fetch fails.
      transcriptionId = parseCreatedTranscriptionId(
        await this.#sdk.stt.create(
          {
            model: this.#model,
            file_id: fileId,
            language_hints: ["en"],
            ...(request.terms.length > 0 ? { context: { terms: request.terms } } : {}),
          },
          signal,
        ),
      );

      // Both calls address the job by the ID we created, never by an ID echoed
      // back by the provider, so a mismatched response cannot redirect the
      // transcript fetch or the billed duration onto another job.
      const finished = parseTranscription(await this.#sdk.stt.wait(transcriptionId, { signal }), transcriptionId);
      const text = parseTranscriptText(await this.#sdk.stt.getTranscript(transcriptionId, signal));

      return { text, durationSeconds: toBillableSeconds(finished.audioDurationMs) };
    } catch (error) {
      if (error instanceof TranscriptionFailure) {
        throw error;
      }

      // An abort is ambiguous at the SDK boundary: it can be the caller
      // disconnecting or our own budget expiring. Decide from the signals we
      // own rather than from the provider's error shape.
      const reason =
        request.signal?.aborted === true
          ? TranscriptionFailureReason.Cancelled
          : timeout.aborted
            ? TranscriptionFailureReason.Timeout
            : toFailureReason(error);

      throw new TranscriptionFailure(reason, {
        cause: error,
        retryAfterSeconds: readProviderRetryAfterSeconds(error),
      });
    } finally {
      // Cleanup gets its own budget so a caller abort or request timeout cannot
      // strand provider-side audio. Failure is logged, never surfaced.
      await this.#cleanup({
        fileId,
        transcriptionId,
        createOutcomeUnknown: createAttempted && transcriptionId === null,
      });
    }
  }

  async #cleanup(ids: {
    fileId: string | null;
    transcriptionId: string | null;
    createOutcomeUnknown: boolean;
  }): Promise<void> {
    // The transcription references the file, so it must go first. Each delete
    // gets its own budget: a slow job delete must not consume the file
    // delete's time and strand uploaded audio.
    const { transcriptionId, fileId, createOutcomeUnknown } = ids;

    // A job may exist under an ID we never received, so it cannot be deleted
    // here. Removing its file anyway would leave that job referencing missing
    // audio; the purge command reconciles both instead.
    if (createOutcomeUnknown) {
      console.error("[SonioxTranscriptionClient] create outcome unknown, leaving provider resources for purge");
      return;
    }

    if (transcriptionId !== null) {
      const deleted = await this.#deleteQuietly(
        () => this.#sdk.stt.delete(transcriptionId, AbortSignal.timeout(this.#cleanupTimeoutMs)),
        "transcription",
      );

      // Deleting the file while its transcription may still exist would leave
      // a job referencing missing audio. Leave both for the purge command.
      if (!deleted) {
        return;
      }
    }

    if (fileId !== null) {
      await this.#deleteQuietly(
        () => this.#sdk.files.delete(fileId, AbortSignal.timeout(this.#cleanupTimeoutMs)),
        "file",
      );
    }
  }

  /** Returns whether the delete succeeded; failures are logged, never thrown. */
  async #deleteQuietly(remove: () => Promise<void>, resource: "file" | "transcription"): Promise<boolean> {
    try {
      await remove();
      return true;
    } catch (error) {
      console.error("[SonioxTranscriptionClient] cleanup failed", {
        resource,
        errorType: safeErrorType({ error }),
      });
      return false;
    }
  }
}

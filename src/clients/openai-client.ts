import OpenAI, { toFile } from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { parseBuffer } from "music-metadata";
import type { AsyncTranscriptionClient } from "./async-transcription-client.js";
import {
  renderTranscriptionPrompt,
  TranscriptionFailure,
  TranscriptionFailureReason,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "../types/transcription.js";

export class OpenAIClient implements AsyncTranscriptionClient {
  readonly #client: OpenAI;
  readonly #model: string;

  constructor(args: { apiKey: string; model: string }) {
    this.#client = new OpenAI({
      apiKey: args.apiKey,
      maxRetries: 2,
      timeout: 60_000,
    });
    this.#model = args.model;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    try {
      const file = await toFile(request.audio, request.filename, { type: request.mimeType });
      const prompt = renderTranscriptionPrompt(request.terms);

      const [response, durationSeconds] = await Promise.all([
        this.#client.audio.transcriptions.create(
          {
            file,
            model: this.#model,
            language: "en",
            response_format: "json",
            ...(prompt ? { prompt } : {}),
          },
          { signal: request.signal },
        ),
        OpenAIClient.parseAudioDuration(request.audio, request.mimeType),
      ]);

      return { text: response.text, durationSeconds };
    } catch (error) {
      // COMPATIBILITY 2026-08-06 (v0.1.0): OpenAI is the shipped default async provider and released apps expect HTTP 500 for every provider failure, so timeout, capacity, and malformed-response failures deliberately collapse to `internal` here instead of using the detailed enum Soniox uses. Only caller cancellation is distinguished. Remove this mapping and classify OpenAI failures like Soniox once OpenAI async rollback support is retired or a breaking error-contract rollout is approved.
      throw new TranscriptionFailure(
        request.signal?.aborted ? TranscriptionFailureReason.Cancelled : TranscriptionFailureReason.Internal,
        { cause: error },
      );
    }
  }

  /**
   * Generate a chat completion using the OpenAI API.
   * @param args - Configuration for the chat completion request
   * @param args.system - System prompt to set the assistant's behavior
   * @param args.userMessage - User message to send to the assistant
   * @param args.model - Model to use (overrides the default model if provided)
   * @param args.responseFormat - Optional response format (e.g., { type: "json_object" })
   * @param args.userId - User ID to use for safety identifier
   * @returns The content string from the first choice in the response
   */
  async chatCompletion(args: {
    system: string;
    userMessage: string;
    model?: string;
    responseFormat?: ChatCompletionCreateParamsNonStreaming["response_format"];
    userId: string;
  }): Promise<string> {
    const response = await this.#client.chat.completions.create(
      {
        model: args.model ?? this.#model,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.userMessage },
        ],
        ...(args.responseFormat ? { response_format: args.responseFormat } : {}),
        reasoning_effort: "minimal",
        safety_identifier: args.userId,
      },
      { timeout: 30_000 },
    );

    const content = response.choices[0]?.message.content;
    if (!content) {
      throw new Error("No content in chat completion response");
    }

    return content;
  }

  private static async parseAudioDuration(buffer: Buffer, mimeType: string): Promise<number> {
    try {
      const metadata = await parseBuffer(buffer, { mimeType });
      if (metadata.format.duration !== undefined && metadata.format.duration > 0) {
        return metadata.format.duration;
      }
      console.warn(
        `[OpenAIClient] Audio metadata missing duration (mime=${mimeType}, size=${buffer.length}), using size-based estimate`,
      );
    } catch (error) {
      console.error(
        `[OpenAIClient] Failed to parse audio metadata (mime=${mimeType}, size=${buffer.length}), using size-based estimate`,
        error,
      );
    }

    return OpenAIClient.estimateDurationFromSize(buffer.length, mimeType);
  }

  /**
   * Conservative byte-rate estimate for voice recordings.
   * - Uncompressed (WAV/PCM): ~96 KB/s  (16-bit, 48 kHz, mono)
   * - Compressed (MP3/AAC/Opus/WebM): ~16 KB/s  (128 kbps)
   * Uses Math.ceil so we never under-count against the daily quota.
   */
  private static estimateDurationFromSize(bytes: number, mimeType: string): number {
    const isUncompressed = mimeType.includes("wav") || mimeType.includes("pcm");
    const bytesPerSecond = isUncompressed ? 96_000 : 16_000;
    return Math.ceil(bytes / bytesPerSecond);
  }
}

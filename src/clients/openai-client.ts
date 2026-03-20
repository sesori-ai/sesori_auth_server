import OpenAI, { toFile } from "openai";
import { parseBuffer } from "music-metadata";

let client: OpenAI | null = null;
let transcriptionModel: string = "gpt-4o-mini-transcribe";

export class OpenAIClient {
  private constructor() {}

  static init(args: { apiKey: string; model: string }): void {
    client = new OpenAI({
      apiKey: args.apiKey,
      maxRetries: 2,
      timeout: 60_000,
    });
    transcriptionModel = args.model;
  }

  static async transcribe(args: {
    fileBuffer: Buffer;
    filename: string;
    mimetype: string;
    prompt?: string;
  }): Promise<{ text: string; durationSeconds: number }> {
    if (!client) {
      throw new Error("OpenAI client not initialized — call OpenAIClient.init() first");
    }

    const file = await toFile(args.fileBuffer, args.filename, { type: args.mimetype });

    const [response, durationSeconds] = await Promise.all([
      client.audio.transcriptions.create({
        file,
        model: transcriptionModel,
        language: "en",
        response_format: "json",
        ...(args.prompt ? { prompt: args.prompt } : {}),
      }),
      OpenAIClient.parseAudioDuration(args.fileBuffer, args.mimetype),
    ]);

    return { text: response.text, durationSeconds };
  }

  private static async parseAudioDuration(buffer: Buffer, mimeType: string): Promise<number> {
    try {
      const metadata = await parseBuffer(buffer, { mimeType });
      return metadata.format.duration ?? 0;
    } catch {
      return 0;
    }
  }
}

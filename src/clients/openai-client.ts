import OpenAI, { toFile } from "openai";

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

  static async transcribe(args: { fileBuffer: Buffer; filename: string; prompt?: string }): Promise<string> {
    if (!client) {
      throw new Error("OpenAI client not initialized — call OpenAIClient.init() first");
    }

    const file = await toFile(args.fileBuffer, args.filename, { type: "audio/m4a" });

    const response = await client.audio.transcriptions.create({
      file,
      model: transcriptionModel,
      language: "en",
      response_format: "json",
      ...(args.prompt ? { prompt: args.prompt } : {}),
    });

    return response.text;
  }
}

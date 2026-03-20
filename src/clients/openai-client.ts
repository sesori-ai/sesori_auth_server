import OpenAI, { toFile } from "openai";

export class OpenAIClient {
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

  async transcribe(args: {
    fileBuffer: Buffer;
    filename: string;
    mimetype: string;
    prompt?: string;
  }): Promise<{ text: string; durationSeconds: number }> {
    const file = await toFile(args.fileBuffer, args.filename, { type: args.mimetype });

    const response = await this.#client.audio.transcriptions.create({
      file,
      model: this.#model,
      language: "en",
      response_format: "verbose_json",
      ...(args.prompt ? { prompt: args.prompt } : {}),
    });

    return { text: response.text, durationSeconds: response.duration ?? 0 };
  }
}

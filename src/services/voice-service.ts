import { GlossaryEntryRepository } from "../repositories/glossary-entry-repo.js";
import { OpenAIClient } from "../clients/openai-client.js";

const MAX_GLOSSARY_SIZE = 500;

export class VoiceService {
  readonly #openai: OpenAIClient;
  readonly #glossaryRepo: GlossaryEntryRepository;

  constructor(deps: { openai: OpenAIClient; glossaryRepo: GlossaryEntryRepository }) {
    this.#openai = deps.openai;
    this.#glossaryRepo = deps.glossaryRepo;
  }

  async transcribe(args: { userId: string; fileBuffer: Buffer; filename: string; mimetype: string }): Promise<string> {
    const glossaryWords = await this.getGlossaryWords(args.userId);
    const prompt = VoiceService.#buildTranscriptionPrompt(glossaryWords);

    return this.#openai.transcribe({
      fileBuffer: args.fileBuffer,
      filename: args.filename,
      mimetype: args.mimetype,
      prompt: prompt ?? undefined,
    });
  }

  async getGlossaryWords(userId: string): Promise<string[]> {
    const entries = await this.#glossaryRepo.findByUserId(userId);
    return entries.map((e) => e.word);
  }

  async addGlossaryWords(args: { userId: string; words: string[] }): Promise<string[]> {
    const currentCount = await this.#glossaryRepo.countByUserId(args.userId);
    const remaining = MAX_GLOSSARY_SIZE - currentCount;

    if (remaining <= 0) {
      return [];
    }

    const wordsToAdd = args.words.slice(0, remaining);
    return this.#glossaryRepo.insertMany({ userId: args.userId, words: wordsToAdd });
  }

  async removeGlossaryWords(args: { userId: string; words: string[] }): Promise<number> {
    return this.#glossaryRepo.deleteMany({ userId: args.userId, words: args.words });
  }

  static #buildTranscriptionPrompt(glossaryWords: string[]): string | null {
    if (glossaryWords.length === 0) return null;
    return `The following terms may appear in the audio: ${glossaryWords.join(", ")}.`;
  }
}

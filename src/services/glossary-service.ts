import type { ProjectKey } from "../models/voice.js";
import { GlossaryEntryRepository } from "../repositories/glossary-entry-repo.js";

export const glossaryPolicy = {
  maxWordsPerRequest: 100,
  maxWordsPerProject: 500,
  maxWordsPerUser: 5_000,
  maxWordCharacters: 200,
  maxContextCharacters: 8_000,
} as const;

export class GlossaryService {
  readonly #glossaryRepo: GlossaryEntryRepository;
  readonly #policy: typeof glossaryPolicy;

  constructor(deps: { glossaryRepo: GlossaryEntryRepository; policy?: typeof glossaryPolicy }) {
    this.#glossaryRepo = deps.glossaryRepo;
    this.#policy = deps.policy ?? glossaryPolicy;
  }

  async listWords(args: { userId: string; projectKey: ProjectKey }): Promise<string[]> {
    const entries = await this.#glossaryRepo.findByUserAndProject(args);
    return entries.map((entry) => entry.word);
  }

  async addWords(args: { userId: string; projectKey: ProjectKey; words: string[] }): Promise<string[]> {
    const words = this.#uniqueWords(args.words);
    const [projectCount, userCount] = await Promise.all([
      this.#glossaryRepo.countByUserAndProject(args),
      this.#glossaryRepo.countByUserId(args.userId),
    ]);
    const remaining = Math.max(
      0,
      Math.min(this.#policy.maxWordsPerProject - projectCount, this.#policy.maxWordsPerUser - userCount),
    );

    return this.#glossaryRepo.insertMany({ ...args, words: words.slice(0, remaining) });
  }

  async removeWords(args: { userId: string; projectKey: ProjectKey; words: string[] }): Promise<number> {
    return this.#glossaryRepo.deleteMany({ ...args, words: this.#uniqueWords(args.words) });
  }

  async getContextWords(args: { userId: string; projectKey: ProjectKey | null }): Promise<string[]> {
    if (args.projectKey === null) {
      return [];
    }

    const words = await this.listWords({ userId: args.userId, projectKey: args.projectKey });
    const sorted = [...words].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const context: string[] = [];
    let length = 0;

    for (const word of sorted) {
      const nextLength = length + (context.length === 0 ? 0 : 2) + word.length;
      if (nextLength > this.#policy.maxContextCharacters) {
        break;
      }

      context.push(word);
      length = nextLength;
    }

    return context;
  }

  #uniqueWords(words: string[]): string[] {
    return [...new Set(words)];
  }
}

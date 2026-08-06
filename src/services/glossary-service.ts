import { BadRequestError } from "../lib/errors.js";
import type { ProjectKey } from "../models/voice.js";
import { GlossaryEntryRepository } from "../repositories/glossary-entry-repo.js";

const PROMPT_PREFIX = "The following terms may appear in the audio: ";
const PROMPT_SUFFIX = ".";

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
    return this.#glossaryRepo.findWordsByUserAndProject(args);
  }

  async addWords(args: { userId: string; projectKey: ProjectKey; words: string[] }): Promise<string[]> {
    const [existing, projectCount, userCount] = await Promise.all([
      this.listWords(args),
      this.#glossaryRepo.countByUserAndProject(args),
      this.#glossaryRepo.countScopedByUserId(args.userId),
    ]);

    // Drop already-persisted terms before applying capacity so a duplicate
    // early in the request cannot consume a slot a new term could have used.
    const persisted = new Set(existing);
    const candidates = this.#uniqueWords(args.words).filter((word) => !persisted.has(word));
    const remaining = Math.max(
      0,
      Math.min(this.#policy.maxWordsPerProject - projectCount, this.#policy.maxWordsPerUser - userCount),
    );

    return this.#glossaryRepo.insertMany({ ...args, words: candidates.slice(0, remaining) });
  }

  async removeWords(args: { userId: string; projectKey: ProjectKey; words: string[] }): Promise<number> {
    return this.#glossaryRepo.deleteMany({ ...args, words: this.#uniqueWords(args.words) });
  }

  /**
   * Builds the provider prompt for one project, or null when there is no
   * context. The cap is enforced on the rendered prompt, so the wrapper text is
   * reserved rather than allowed to push the request past the budget.
   */
  async buildTranscriptionPrompt(args: { userId: string; projectKey: ProjectKey | null }): Promise<string | null> {
    const words = await this.getContextWords(args);
    if (words.length === 0) {
      return null;
    }

    return `${PROMPT_PREFIX}${words.join(", ")}${PROMPT_SUFFIX}`;
  }

  async getContextWords(args: { userId: string; projectKey: ProjectKey | null }): Promise<string[]> {
    if (args.projectKey === null) {
      return [];
    }

    const words = await this.listWords({ userId: args.userId, projectKey: args.projectKey });
    const sorted = [...words].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const budget = this.#policy.maxContextCharacters - PROMPT_PREFIX.length - PROMPT_SUFFIX.length;
    const context: string[] = [];
    let length = 0;

    for (const word of sorted) {
      const nextLength = length + (context.length === 0 ? 0 : 2) + word.length;
      if (nextLength > budget) {
        break;
      }

      context.push(word);
      length = nextLength;
    }

    return context;
  }

  /**
   * Applies the safety policy the routes also validate, so a non-route caller
   * cannot bypass it. Words are trimmed, empties dropped, and exact duplicates
   * removed while preserving first request occurrence.
   */
  #uniqueWords(words: string[]): string[] {
    if (words.length > this.#policy.maxWordsPerRequest) {
      throw new BadRequestError({ debugMessage: "Too many glossary words in one request" });
    }

    const normalized = words.map((word) => word.trim());
    if (normalized.some((word) => word.length === 0 || word.length > this.#policy.maxWordCharacters)) {
      throw new BadRequestError({ debugMessage: "Invalid glossary word length" });
    }

    return [...new Set(normalized)];
  }
}

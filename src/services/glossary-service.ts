import { BadRequestError } from "../lib/errors.js";
import { ProjectGlossaryScopeType, type ProjectGlossaryScope, type ProjectKey } from "../models/voice.js";
import { TRANSCRIPTION_PROMPT_PREFIX, TRANSCRIPTION_PROMPT_SUFFIX } from "../types/transcription.js";
import type { BridgeRepository } from "../repositories/bridge-repo.js";
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
  readonly #bridgeRepo: BridgeRepository;
  readonly #policy: typeof glossaryPolicy;

  constructor(deps: {
    glossaryRepo: GlossaryEntryRepository;
    bridgeRepo: BridgeRepository;
    policy?: typeof glossaryPolicy;
  }) {
    this.#glossaryRepo = deps.glossaryRepo;
    this.#bridgeRepo = deps.bridgeRepo;
    this.#policy = deps.policy ?? glossaryPolicy;
  }

  async listWords(args: { userId: string; projectKey: ProjectKey }): Promise<string[]> {
    return this.#glossaryRepo.findWordsByUserAndProject(args);
  }

  async addWords(args: { userId: string; scope: ProjectGlossaryScope; words: string[] }): Promise<string[]> {
    // Validate before glossary database work so a rejected request cannot
    // recreate local rows for an unknown, foreign, or revoked bridge.
    const requested = this.#uniqueWords(args.words);
    if (args.scope.type === ProjectGlossaryScopeType.bridgeLocal) {
      await this.#requireActiveBridge({ userId: args.userId, bridgeId: args.scope.bridgeId });
    }

    const project = { userId: args.userId, projectKey: args.scope.projectKey };
    const [existing, projectCount, userCount] = await Promise.all([
      this.#glossaryRepo.findWordsByUserAndScope({ userId: args.userId, scope: args.scope }),
      this.#glossaryRepo.countByUserAndProject(project),
      this.#glossaryRepo.countScopedByUserId(args.userId),
    ]);

    // Drop already-persisted terms before applying capacity so a duplicate
    // early in the request cannot consume a slot a new term could have used.
    const persisted = new Set(existing);
    const candidates = requested.filter((word) => !persisted.has(word));
    const remaining = Math.max(
      0,
      Math.min(this.#policy.maxWordsPerProject - projectCount, this.#policy.maxWordsPerUser - userCount),
    );

    const added = await this.#glossaryRepo.addWords({
      userId: args.userId,
      scope: args.scope,
      words: candidates.slice(0, remaining),
    });

    if (args.scope.type === ProjectGlossaryScopeType.bridgeLocal) {
      const activeBridge = await this.#bridgeRepo.findByIdForUser(args.scope.bridgeId, args.userId);
      if (!activeBridge) {
        // Revocation can race between the first ownership check and insertion.
        // Delete every local row for the now-inactive bridge before refusing the
        // request so stale credentials cannot recreate deleted vocabulary.
        await this.#glossaryRepo.deleteByUserAndBridge({ userId: args.userId, bridgeId: args.scope.bridgeId });
        throw new BadRequestError({ debugMessage: "Bridge not found or revoked" });
      }
    }

    return added;
  }

  async removeWords(args: { userId: string; scope: ProjectGlossaryScope; words: string[] }): Promise<number> {
    const requested = this.#uniqueWords(args.words);
    if (args.scope.type === ProjectGlossaryScopeType.bridgeLocal) {
      await this.#requireActiveBridge({ userId: args.userId, bridgeId: args.scope.bridgeId });
    }

    return this.#glossaryRepo.removeWords({ userId: args.userId, scope: args.scope, words: requested });
  }

  async getContextWords(args: { userId: string; projectKey: ProjectKey | null }): Promise<string[]> {
    if (args.projectKey === null) {
      return [];
    }

    const words = await this.listWords({ userId: args.userId, projectKey: args.projectKey });
    const sorted = [...new Set(words)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const budget =
      this.#policy.maxContextCharacters - TRANSCRIPTION_PROMPT_PREFIX.length - TRANSCRIPTION_PROMPT_SUFFIX.length;
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

  async #requireActiveBridge(args: { userId: string; bridgeId: string }): Promise<void> {
    const bridge = await this.#bridgeRepo.findByIdForUser(args.bridgeId, args.userId);
    if (!bridge) {
      throw new BadRequestError({ debugMessage: "Bridge not found or revoked" });
    }
  }

  /**
   * Applies the safety policy the routes also validate, so a non-route caller
   * cannot bypass it. Words are trimmed, empty and over-long words are
   * rejected, and exact duplicates are removed preserving first occurrence.
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

import { OpenAIClient } from "../clients/openai-client.js";
import { InternalServerError, QuotaExceededError } from "../lib/errors.js";
import { generateMetadataReplySchema } from "../models/api.js";
import type { DailyUsageRepository } from "../repositories/daily-usage-repo.js";

const DAILY_METADATA_LIMIT = 100;

const SYSTEM_PROMPT =
  'Read the user\'s first message and generate session metadata. Return a concise title using 2 to 6 words. Return a git-branch-safe branch name in lowercase hyphenated form, max 60 chars. Return a git worktree name in lowercase hyphenated form, max 60 chars. Respond ONLY with valid JSON in this exact shape: {"title":"...","branchName":"...","worktreeName":"..."}. No markdown fences. No explanation. Only JSON.';

function sanitizeBranchName(raw: string): string | null {
  if (!raw) return null;

  let result = raw.toLowerCase();

  result = result.replace(/[ _/]/g, "-");
  result = result.replace(/\.+$/, "");
  if (result.endsWith(".lock")) {
    result = result.substring(0, result.length - 5);
  }
  if (result.includes("..")) return null;
  result = result.replace(/[^a-z0-9-]/g, "");
  result = result.replace(/-+/g, "-");
  result = result.replace(/^-+|-+$/g, "");

  if (result.length > 60) {
    result = result.substring(0, 60);
    const lastHyphenIndex = result.lastIndexOf("-");
    if (lastHyphenIndex > 0) {
      result = result.substring(0, lastHyphenIndex);
    }
  }

  return result || null;
}

export class SessionMetadataService {
  readonly #openai: OpenAIClient;
  readonly #dailyUsageRepo: DailyUsageRepository;
  readonly #model: string;

  constructor(deps: { openai: OpenAIClient; dailyUsageRepo: DailyUsageRepository; model: string }) {
    this.#openai = deps.openai;
    this.#dailyUsageRepo = deps.dailyUsageRepo;
    this.#model = deps.model;
  }

  async generateMetadata(args: {
    userId: string;
    firstMessage: string;
  }): Promise<{ title: string; branchName: string; worktreeName: string }> {
    const { previousCount } = await this.#dailyUsageRepo.incrementMetadataRequestCount(args.userId);
    if (previousCount >= DAILY_METADATA_LIMIT) {
      throw new QuotaExceededError({
        service: "metadata",
        debugMessage: `Daily metadata limit reached: ${previousCount}/${DAILY_METADATA_LIMIT}`,
      });
    }

    let rawResponse: string;
    try {
      rawResponse = await this.#openai.chatCompletion({
        system: SYSTEM_PROMPT,
        userMessage: args.firstMessage,
        model: this.#model,
        responseFormat: { type: "json_object" },
      });
    } catch (error) {
      throw new InternalServerError({
        debugMessage: "OpenAI chat completion failed during metadata generation",
        nestedError: error,
      });
    }

    const parseResult = generateMetadataReplySchema.safeParse(
      (() => {
        try {
          return JSON.parse(rawResponse);
        } catch {
          return null;
        }
      })(),
    );

    if (!parseResult.success || !parseResult.data.title || !parseResult.data.branchName) {
      throw new InternalServerError({
        debugMessage: `Invalid metadata response: ${rawResponse}`,
      });
    }

    const { title } = parseResult.data;
    const branchName = sanitizeBranchName(parseResult.data.branchName);
    const worktreeName = sanitizeBranchName(parseResult.data.worktreeName);
    if (!branchName || !worktreeName) {
      throw new InternalServerError({
        debugMessage: `Empty after sanitization: branch="${parseResult.data.branchName}" worktree="${parseResult.data.worktreeName}"`,
      });
    }

    return { title, branchName, worktreeName };
  }
}

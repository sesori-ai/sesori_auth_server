import { OpenAIClient } from "../clients/openai-client.js";
import { MetadataRateLimiter } from "./metadata-rate-limiter.js";
import { InternalServerError } from "../lib/errors.js";
import { generateMetadataReplySchema } from "../models/api.js";

const SYSTEM_PROMPT =
  'Read the user\'s first message and generate session metadata. Return a concise title using 2 to 6 words. Return a git-branch-safe branch name in lowercase hyphenated form, max 60 chars. Respond ONLY with valid JSON in this exact shape: {"title":"...","branchName":"..."}. No markdown fences. No explanation. Only JSON.';

/**
 * Sanitizes an arbitrary string into a git-safe branch name.
 *
 * Replicates the Dart sanitizeBranchName logic:
 * 1. Lowercase
 * 2. Replace spaces, underscores, slashes with hyphens
 * 3. Strip trailing dots and `.lock` suffix
 * 4. Reject if contains `..` anywhere
 * 5. Strip all non-alphanumeric characters (except hyphens)
 * 6. Collapse consecutive hyphens
 * 7. Strip leading/trailing hyphens
 * 8. Truncate to 60 chars at a hyphen boundary if possible
 * 9. Return null if result is empty
 */
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

  if (!result) return null;

  return result;
}

/**
 * Generates session metadata (title and git-safe branch name) from the user's
 * first message using OpenAI chat completion.
 */
export class SessionMetadataService {
  readonly #openai: OpenAIClient;
  readonly #rateLimiter: MetadataRateLimiter;
  readonly #model: string;

  constructor(deps: { openai: OpenAIClient; rateLimiter: MetadataRateLimiter; model: string }) {
    this.#openai = deps.openai;
    this.#rateLimiter = deps.rateLimiter;
    this.#model = deps.model;
  }

  /**
   * Generates a session title and git-safe branch name from the user's first message.
   *
   * Flow:
   *  1. Check and increment the rate limiter for the user (throws 429 if exceeded).
   *  2. Call OpenAI chat completion with the system prompt and user's first message.
   *  3. Parse the JSON response and validate title and branchName are non-empty strings.
   *  4. Sanitize the branch name server-side.
   *  5. Return { title, branchName }.
   *
   * @throws QuotaExceededError (429) when the rate limit is exceeded.
   * @throws InternalServerError (500) when OpenAI fails or the response is invalid.
   */
  async generateMetadata(args: {
    userId: string;
    firstMessage: string;
  }): Promise<{ title: string; branchName: string }> {
    await this.#rateLimiter.checkAndIncrement(args.userId);

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
    const rawBranchName = parseResult.data.branchName;

    const branchName = sanitizeBranchName(rawBranchName);
    if (!branchName) {
      throw new InternalServerError({
        debugMessage: `Branch name is empty after sanitization: "${rawBranchName}"`,
      });
    }

    return { title, branchName };
  }
}

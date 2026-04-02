import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { MetadataUsageRepository } from "../repositories/metadata-usage-repo.js";
import { QuotaExceededError } from "../lib/errors.js";

const PER_MINUTE_LIMIT = 5;
const PER_DAY_LIMIT = 100;
const ONE_MINUTE_MS = 60_000;

/**
 * Rate limiter for session metadata requests.
 *
 * Enforces two independent limits per user:
 *  - 5 requests per minute  (in-memory sliding window — no DB call)
 *  - 100 requests per day   (MongoDB atomic counter)
 *
 * The per-minute check runs first to short-circuit burst traffic before
 * touching the database. Throws QuotaExceededError (HTTP 429) when either
 * limit is exceeded.
 */
export class MetadataRateLimiter {
  readonly #usageRepo: MetadataUsageRepository;
  readonly #perMinuteWindows = new Map<string, number[]>();

  constructor(accessor: MongoDbAccessor) {
    this.#usageRepo = new MetadataUsageRepository(accessor);
  }

  /**
   * Checks per-minute and per-day rate limits for the given user and, if both
   * pass, atomically increments the daily counter.
   *
   * Per-minute check uses an in-memory sliding window over the last 60 seconds.
   * Timestamps older than 60 seconds are pruned on every call.
   * Per-day check uses a MongoDB atomic counter (findOneAndUpdate / upsert).
   * The daily counter is incremented before the limit is evaluated so the
   * operation is a single atomic DB write; requests that arrive after the quota
   * is exhausted are rejected based on the snapshot returned before increment.
   *
   * @throws QuotaExceededError when the per-minute or per-day limit is exceeded.
   */
  async checkAndIncrement(userId: string): Promise<void> {
    const now = Date.now();
    const cutoff = now - ONE_MINUTE_MS;

    const timestamps = (this.#perMinuteWindows.get(userId) ?? []).filter((ts) => ts > cutoff);

    if (timestamps.length >= PER_MINUTE_LIMIT) {
      throw new QuotaExceededError({
        service: "metadata",
        debugMessage: `Per-minute metadata limit reached: ${timestamps.length}/${PER_MINUTE_LIMIT} requests in the last 60 seconds`,
      });
    }

    // Atomically increment daily counter and check whether quota was already
    // exhausted before this request arrived.
    const { previousCount } = await this.#usageRepo.incrementCount(userId);

    if (previousCount >= PER_DAY_LIMIT) {
      throw new QuotaExceededError({
        service: "metadata",
        debugMessage: `Daily metadata limit reached: ${previousCount}/${PER_DAY_LIMIT} requests today`,
      });
    }

    timestamps.push(now);
    this.#perMinuteWindows.set(userId, timestamps);
  }
}

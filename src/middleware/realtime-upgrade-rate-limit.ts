import type { FastifyReply, FastifyRequest } from "fastify";

const WINDOW_MS = 60_000;

export type RealtimeUpgradeRateLimiterOptions = {
  readonly maxUpgradesPerMinute: number;
  readonly clock?: () => number;
};

export function createRealtimeUpgradeRateLimit(options: RealtimeUpgradeRateLimiterOptions) {
  const clock = options.clock ?? Date.now;
  let windowStartedAt = clock();
  let count = 0;

  return async function realtimeUpgradeRateLimit(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const now = clock();
    if (now - windowStartedAt >= WINDOW_MS) {
      windowStartedAt = now;
      count = 0;
    }

    count += 1;
    if (count > options.maxUpgradesPerMinute) {
      await reply.status(429).send({ error: "rate_limited" });
    }
  };
}

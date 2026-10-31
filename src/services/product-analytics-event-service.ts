import { BadRequestError } from "../lib/errors.js";
import { ProductAnalyticsPreference, type ProductAnalyticsEventBody } from "../types/product-analytics.js";

const MICROS_PER_MILLISECOND = 1_000;
const MICROS_PER_SECOND = 1_000_000;
// Stops an account backdating its first message.
const MAX_EVENT_AGE_MICROS = 72 * 60 * 60 * MICROS_PER_SECOND;
const MAX_EVENT_FUTURE_MICROS = 300 * MICROS_PER_SECOND;

type ProductAnalyticsEventPreferenceReader = {
  getPreference(input: { userId: string }): Promise<{ preference: ProductAnalyticsPreference; userKey: string }>;
  isExportSuppressed(input: { userId: string }): Promise<boolean>;
};

type ProductAnalyticsEventWriter = {
  insert(input: { userKey: string; event: ProductAnalyticsEventBody; receivedAt: Date }): Promise<void>;
  deleteForUserKey(input: { userKey: string }): Promise<void>;
};

export class ProductAnalyticsEventService {
  readonly #preferenceService: ProductAnalyticsEventPreferenceReader;
  readonly #eventRepo: ProductAnalyticsEventWriter;
  readonly #clock: () => Date;

  constructor(deps: {
    preferenceService: ProductAnalyticsEventPreferenceReader;
    eventRepo: ProductAnalyticsEventWriter;
    clock?: () => Date;
  }) {
    this.#preferenceService = deps.preferenceService;
    this.#eventRepo = deps.eventRepo;
    this.#clock = deps.clock ?? (() => new Date());
  }

  async record(input: { userId: string; event: ProductAnalyticsEventBody }): Promise<void> {
    // One clock read serves both the time bound and receivedAt, so a stored row
    // always satisfies the warehouse's occurred_at <= emitted_at + 300s.
    const receivedAt = this.#clock();
    const receivedAtMicros = receivedAt.getTime() * MICROS_PER_MILLISECOND;
    const { occurredAtMicros } = input.event;
    if (
      occurredAtMicros < receivedAtMicros - MAX_EVENT_AGE_MICROS ||
      occurredAtMicros > receivedAtMicros + MAX_EVENT_FUTURE_MICROS
    ) {
      throw new BadRequestError({
        debugMessage: "Invalid product analytics event",
        nestedError: [{ code: "out_of_range", path: ["occurredAtMicros"] }],
      });
    }

    // A suppressed account reads as disabled, so this also blocks it.
    const { preference, userKey } = await this.#preferenceService.getPreference({ userId: input.userId });
    if (preference !== ProductAnalyticsPreference.Enabled) {
      return;
    }

    await this.#eventRepo.insert({ userKey, event: input.event, receivedAt });

    // A suppression can commit and finish its delete between the read above and this insert, which would recreate a
    // row it already removed. If its tombstone isn't visible here, it commits later, so its delete follows the insert.
    if (await this.#preferenceService.isExportSuppressed({ userId: input.userId })) {
      await this.#eventRepo.deleteForUserKey({ userKey });
    }
  }
}

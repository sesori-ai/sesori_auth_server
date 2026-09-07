import { z } from "zod";
import type { OptionalEmailPreferenceRepository } from "../repositories/optional-email-preference-repo.js";
import type { OptionalEmailWebhookEventRepository } from "../repositories/optional-email-webhook-event-repo.js";
import { OptionalEmailSuppressionReason } from "../types/optional-email.js";

const webhookEventSchema = z
  .object({
    type: z.string().min(1).max(128),
    data: z
      .object({
        email_id: z.string().min(1).max(256),
        bounce: z
          .object({ type: z.string().min(1).max(64) })
          .passthrough()
          .optional(),
        tags: z.record(z.string(), z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface OptionalEmailSendHistoryLookup {
  findUserIdByProviderEmailId(input: { providerEmailId: string }): Promise<string | null>;
}

export type OptionalEmailWebhookResult =
  | { status: "processed"; outcome: "suppressed" | "ignored" }
  | { status: "replayed" }
  | { status: "retry" };

export class OptionalEmailWebhookService {
  readonly #eventRepo: OptionalEmailWebhookEventRepository;
  readonly #preferenceRepo: OptionalEmailPreferenceRepository;
  readonly #sendHistory: OptionalEmailSendHistoryLookup;
  readonly #clock: () => Date;

  constructor(input: {
    eventRepo: OptionalEmailWebhookEventRepository;
    preferenceRepo: OptionalEmailPreferenceRepository;
    sendHistory: OptionalEmailSendHistoryLookup;
    clock?: () => Date;
  }) {
    this.#eventRepo = input.eventRepo;
    this.#preferenceRepo = input.preferenceRepo;
    this.#sendHistory = input.sendHistory;
    this.#clock = input.clock ?? (() => new Date());
  }

  async handleVerified(input: { eventId: string; event: unknown }): Promise<OptionalEmailWebhookResult> {
    if (await this.#eventRepo.wasProcessed({ eventId: input.eventId })) {
      return { status: "replayed" };
    }
    const parsed = webhookEventSchema.safeParse(input.event);
    if (!parsed.success) {
      throw new Error("InvalidResendWebhookEvent");
    }

    const event = parsed.data;
    const optionalEvent = event.data.tags?.category === "optional_setup_reminder";
    const reason =
      event.type === "email.bounced" && event.data.bounce?.type === "Permanent"
        ? OptionalEmailSuppressionReason.HardBounce
        : event.type === "email.complained"
          ? OptionalEmailSuppressionReason.Complaint
          : event.type === "email.suppressed"
            ? OptionalEmailSuppressionReason.ProviderSuppressed
            : null;
    if (!optionalEvent || !reason) {
      const inserted = await this.#eventRepo.recordProcessed({
        eventId: input.eventId,
        eventType: event.type,
        processedAt: this.#clock(),
      });
      return inserted ? { status: "processed", outcome: "ignored" } : { status: "replayed" };
    }

    const userId = await this.#sendHistory.findUserIdByProviderEmailId({
      providerEmailId: event.data.email_id,
    });
    if (!userId) {
      return { status: "retry" };
    }

    await this.#preferenceRepo.suppress({ userId, reason, at: this.#clock() });
    const inserted = await this.#eventRepo.recordProcessed({
      eventId: input.eventId,
      eventType: event.type,
      processedAt: this.#clock(),
    });
    return inserted ? { status: "processed", outcome: "suppressed" } : { status: "replayed" };
  }
}

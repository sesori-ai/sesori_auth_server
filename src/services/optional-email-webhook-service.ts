import { z } from "zod";
import type { OptionalEmailPreferenceRepository } from "../repositories/optional-email-preference-repo.js";
import type { OptionalEmailWebhookEventRepository } from "../repositories/optional-email-webhook-event-repo.js";
import {
  OptionalEmailCategory,
  OptionalEmailSuppressionReason,
  OptionalEmailWebhookEventType,
  OptionalEmailWebhookOutcome,
  OptionalEmailWebhookStatus,
} from "../types/optional-email.js";

const webhookEventTypeSchema = z.string().min(1).max(128);
const webhookEnvelopeSchema = z
  .object({
    type: webhookEventTypeSchema.optional(),
    event_type: webhookEventTypeSchema.optional(),
  })
  .passthrough()
  .refine(
    (event) =>
      (event.type !== undefined || event.event_type !== undefined) &&
      (event.type === undefined || event.event_type === undefined || event.type === event.event_type),
  )
  .transform((event) => event.type ?? event.event_type!);

const webhookEventSchema = z
  .object({
    type: webhookEventTypeSchema,
    data: z
      .object({
        email_id: z.string().min(1).max(256),
        bounce: z
          .object({ type: z.string().min(1).max(64) })
          .passthrough()
          .optional(),
        tags: z.record(z.string().min(1).max(64), z.string().max(256)).optional(),
      })
      .passthrough(),
  })
  .passthrough();

function isSuppressionEventType(eventType: string): eventType is OptionalEmailWebhookEventType {
  return (
    eventType === OptionalEmailWebhookEventType.Bounced ||
    eventType === OptionalEmailWebhookEventType.Complained ||
    eventType === OptionalEmailWebhookEventType.Suppressed
  );
}

export interface OptionalEmailSendHistoryLookup {
  findUserIdByProviderEmailId(input: { providerEmailId: string }): Promise<string | null>;
}

export type OptionalEmailWebhookResult =
  | { status: OptionalEmailWebhookStatus.Processed; outcome: OptionalEmailWebhookOutcome }
  | { status: OptionalEmailWebhookStatus.Replayed }
  | { status: OptionalEmailWebhookStatus.Retry };

export class InvalidResendWebhookEventError extends Error {
  constructor() {
    super("InvalidResendWebhookEvent");
    this.name = "InvalidResendWebhookEventError";
  }
}

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
      return { status: OptionalEmailWebhookStatus.Replayed };
    }

    const envelope = webhookEnvelopeSchema.safeParse(input.event);
    if (!envelope.success) {
      throw new InvalidResendWebhookEventError();
    }

    const parsed = webhookEventSchema.safeParse(input.event);
    if (!parsed.success) {
      if (isSuppressionEventType(envelope.data)) {
        throw new InvalidResendWebhookEventError();
      }

      return this.#recordIgnored({ eventId: input.eventId, eventType: envelope.data });
    }

    const event = parsed.data;
    const optionalEvent = event.data.tags?.category === OptionalEmailCategory.SetupReminder;
    const reason = this.#suppressionReason(event);
    if (!optionalEvent || !reason) {
      return this.#recordIgnored({ eventId: input.eventId, eventType: event.type });
    }

    const userId = await this.#sendHistory.findUserIdByProviderEmailId({
      providerEmailId: event.data.email_id,
    });
    if (!userId) {
      return { status: OptionalEmailWebhookStatus.Retry };
    }

    await this.#preferenceRepo.suppress({ userId, reason, at: this.#clock() });
    const inserted = await this.#eventRepo.recordProcessed({
      eventId: input.eventId,
      eventType: event.type,
      processedAt: this.#clock(),
    });
    return inserted
      ? { status: OptionalEmailWebhookStatus.Processed, outcome: OptionalEmailWebhookOutcome.Suppressed }
      : { status: OptionalEmailWebhookStatus.Replayed };
  }

  async #recordIgnored(input: { eventId: string; eventType: string }): Promise<OptionalEmailWebhookResult> {
    const inserted = await this.#eventRepo.recordProcessed({
      ...input,
      processedAt: this.#clock(),
    });
    return inserted
      ? { status: OptionalEmailWebhookStatus.Processed, outcome: OptionalEmailWebhookOutcome.Ignored }
      : { status: OptionalEmailWebhookStatus.Replayed };
  }

  #suppressionReason(event: z.infer<typeof webhookEventSchema>): OptionalEmailSuppressionReason | null {
    if (event.type === OptionalEmailWebhookEventType.Bounced && event.data.bounce?.type === "Permanent") {
      return OptionalEmailSuppressionReason.HardBounce;
    }

    if (event.type === OptionalEmailWebhookEventType.Complained) {
      return OptionalEmailSuppressionReason.Complaint;
    }

    if (event.type === OptionalEmailWebhookEventType.Suppressed) {
      return OptionalEmailSuppressionReason.ProviderSuppressed;
    }

    return null;
  }
}

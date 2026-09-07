import { createHash } from "node:crypto";
import {
  type OptionalEmailProvider,
  ResendOptionalEmailError,
  type ResendOptionalEmailErrorCode,
} from "../clients/resend-optional-email-adapter.js";
import type { OptionalEmailDailyQuotaRepository } from "../repositories/optional-email-daily-quota-repo.js";
import type { OptionalEmailSendRepository } from "../repositories/optional-email-send-repo.js";
import type { OptionalEmailEligibilityResult } from "./optional-email-eligibility-service.js";
import {
  buildOptionalEmailUnsubscribeHeaders,
  type OptionalEmailUnsubscribeTokenService,
} from "./optional-email-unsubscribe-service.js";
import { OptionalEmailReminderKind } from "../types/optional-email.js";

interface OptionalEmailEligibilityCheck {
  evaluate(input: { userId: string; reminderKind: OptionalEmailReminderKind }): Promise<OptionalEmailEligibilityResult>;
}

export type OptionalEmailDeliveryResult =
  | { status: "sent"; sendKey: string; providerEmailId: string }
  | { status: "blocked"; reason: string; sendKey?: string }
  | { status: "duplicate"; sendKey: string }
  | { status: "daily_limit"; sendKey: string }
  | { status: "provider_failed"; sendKey: string; code: ResendOptionalEmailErrorCode };

export class OptionalEmailDeliveryService {
  readonly #eligibility: OptionalEmailEligibilityCheck;
  readonly #sendRepo: OptionalEmailSendRepository;
  readonly #quotaRepo: OptionalEmailDailyQuotaRepository;
  readonly #provider: OptionalEmailProvider;
  readonly #tokenService: OptionalEmailUnsubscribeTokenService;
  readonly #policy: {
    from: string;
    replyTo: string;
    publicBaseUrl: string;
    dailyCap: number;
    testRecipient: string;
    testSendEnabled: boolean;
  };
  readonly #clock: () => Date;

  constructor(input: {
    eligibility: OptionalEmailEligibilityCheck;
    sendRepo: OptionalEmailSendRepository;
    quotaRepo: OptionalEmailDailyQuotaRepository;
    provider: OptionalEmailProvider;
    tokenService: OptionalEmailUnsubscribeTokenService;
    policy: {
      from: string;
      replyTo: string;
      publicBaseUrl: string;
      dailyCap: number;
      testRecipient: string;
      testSendEnabled: boolean;
    };
    clock?: () => Date;
  }) {
    this.#eligibility = input.eligibility;
    this.#sendRepo = input.sendRepo;
    this.#quotaRepo = input.quotaRepo;
    this.#provider = input.provider;
    this.#tokenService = input.tokenService;
    this.#policy = input.policy;
    this.#clock = input.clock ?? (() => new Date());
  }

  async sendReminder(input: {
    userId: string;
    campaignId: string;
    reminderKind: OptionalEmailReminderKind;
  }): Promise<OptionalEmailDeliveryResult> {
    return this.#deliverReminder(input);
  }

  async #deliverReminder(input: {
    userId: string;
    campaignId: string;
    reminderKind: OptionalEmailReminderKind;
    requiredRecipient?: string;
  }): Promise<OptionalEmailDeliveryResult> {
    const firstEligibility = await this.#eligibility.evaluate({
      userId: input.userId,
      reminderKind: input.reminderKind,
    });
    if (!firstEligibility.eligible) {
      return { status: "blocked", reason: firstEligibility.reason };
    }
    if (input.requiredRecipient && firstEligibility.recipient.trim().toLowerCase() !== input.requiredRecipient) {
      return { status: "blocked", reason: "test_recipient_not_allowed" };
    }

    const sendKey = buildSendKey(input);
    const now = this.#clock();
    const reservation = await this.#sendRepo.reserve({ ...input, sendKey, at: now });
    if (reservation.status === "duplicate") {
      return { status: "duplicate", sendKey };
    }
    if (reservation.status === "retry_expired") {
      return { status: "blocked", reason: "retry_window_expired" };
    }
    const quota = await this.#quotaRepo.reserve({ at: now, dailyCap: this.#policy.dailyCap });
    if (!quota.reserved) {
      if (!(await this.#sendRepo.markDeferredForDailyLimit({ sendKey, at: this.#clock() }))) {
        throw new Error("OptionalEmailDailyLimitHistoryWriteFailed");
      }
      return { status: "daily_limit", sendKey };
    }

    const finalEligibility = await this.#eligibility.evaluate({
      userId: input.userId,
      reminderKind: input.reminderKind,
    });
    if (!finalEligibility.eligible) {
      if (
        !(await this.#sendRepo.markBlocked({
          sendKey,
          reason: finalEligibility.reason,
          at: this.#clock(),
        }))
      ) {
        throw new Error("OptionalEmailBlockedHistoryWriteFailed");
      }
      return { status: "blocked", reason: finalEligibility.reason, sendKey };
    }
    if (input.requiredRecipient && finalEligibility.recipient.trim().toLowerCase() !== input.requiredRecipient) {
      if (
        !(await this.#sendRepo.markBlocked({
          sendKey,
          reason: "test_recipient_not_allowed",
          at: this.#clock(),
        }))
      ) {
        throw new Error("OptionalEmailBlockedHistoryWriteFailed");
      }
      return { status: "blocked", reason: "test_recipient_not_allowed", sendKey };
    }
    if (!(await this.#sendRepo.markInFlight({ sendKey, at: this.#clock() }))) {
      throw new Error("OptionalEmailSendClaimLost");
    }

    const token = this.#tokenService.create({ userId: input.userId });
    const headers = buildOptionalEmailUnsubscribeHeaders({
      publicBaseUrl: this.#policy.publicBaseUrl,
      token,
    });
    const unsubscribeUrl = headers["List-Unsubscribe"].slice(1, -1);
    const content = buildReminderContent(input.reminderKind, unsubscribeUrl);
    let providerResult: { providerEmailId: string };
    try {
      providerResult = await this.#provider.send({
        idempotencyKey: sendKey,
        from: this.#policy.from,
        replyTo: this.#policy.replyTo,
        recipient: finalEligibility.recipient,
        subject: content.subject,
        html: content.html,
        text: content.text,
        headers,
        tags: [
          { name: "category", value: "optional_setup_reminder" },
          { name: "campaign", value: input.campaignId },
        ],
      });
    } catch (error) {
      const code: ResendOptionalEmailErrorCode = error instanceof ResendOptionalEmailError ? error.code : "unavailable";
      if (!(await this.#sendRepo.markFailed({ sendKey, failureCode: code, at: this.#clock() }))) {
        throw new Error("OptionalEmailFailedHistoryWriteFailed", { cause: error });
      }
      return { status: "provider_failed", sendKey, code };
    }
    if (
      !(await this.#sendRepo.markAccepted({
        sendKey,
        providerEmailId: providerResult.providerEmailId,
        at: this.#clock(),
      }))
    ) {
      throw new Error("OptionalEmailAcceptedHistoryWriteFailed");
    }
    return { status: "sent", sendKey, providerEmailId: providerResult.providerEmailId };
  }

  async sendTest(_input: {
    userId: string;
    recipient: string;
    operationId: string;
    templateKind: OptionalEmailReminderKind;
  }): Promise<OptionalEmailDeliveryResult> {
    if (!this.#policy.testSendEnabled) {
      return { status: "blocked", reason: "test_sending_disabled" };
    }
    const pinnedRecipient = "alex@sesori.com";
    if (
      this.#policy.testRecipient.trim().toLowerCase() !== pinnedRecipient ||
      _input.recipient.trim().toLowerCase() !== pinnedRecipient
    ) {
      return { status: "blocked", reason: "test_recipient_not_allowed" };
    }
    return this.#deliverReminder({
      userId: _input.userId,
      campaignId: `test_${_input.operationId}`,
      reminderKind: _input.templateKind,
      requiredRecipient: pinnedRecipient,
    });
  }
}

function buildSendKey(input: { userId: string; campaignId: string; reminderKind: OptionalEmailReminderKind }): string {
  const digest = createHash("sha256")
    .update(`${input.campaignId}\u0000${input.userId}\u0000${input.reminderKind}`, "utf8")
    .digest("hex");
  return `optional/${digest}`;
}

function buildReminderContent(
  reminderKind: OptionalEmailReminderKind,
  unsubscribeUrl: string,
): { subject: string; html: string; text: string } {
  const message =
    reminderKind === OptionalEmailReminderKind.FirstSession
      ? {
          subject: "Run your first coding session with Sesori",
          sentence: "Run your first coding session through the Sesori Bridge.",
        }
      : {
          subject: "Finish setting up Sesori",
          sentence: "Finish connecting your coding setup to Sesori.",
        };
  return {
    subject: message.subject,
    html: `<p>${message.sentence}</p><p><a href="${unsubscribeUrl}">Unsubscribe</a> from optional setup reminders.</p>`,
    text: `${message.sentence}\n\nUnsubscribe: ${unsubscribeUrl}`,
  };
}

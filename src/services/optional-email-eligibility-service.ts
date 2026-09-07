import type { OptionalEmailRecipientResolution } from "../types/optional-email.js";
import {
  OptionalEmailBlockReason,
  OptionalEmailRecipientBasis,
  OptionalEmailRecipientStatus,
  OptionalEmailReminderKind,
  OptionalEmailSendBlockReason,
} from "../types/optional-email.js";

export interface OptionalEmailRecipientLookup {
  resolve(input: { userId: string }): Promise<OptionalEmailRecipientResolution>;
}

export interface OptionalEmailPreferenceLookup {
  findBlockReason(input: { userId: string }): Promise<OptionalEmailBlockReason | null>;
}

export interface OptionalEmailActivationStateLookup {
  findByUserId(input: { userId: string }): Promise<{ bridgeSetupAt: Date | null; firstSessionAt: Date | null } | null>;
}

export type OptionalEmailIneligibleResult = { eligible: false; reason: OptionalEmailSendBlockReason };
export type OptionalEmailEligibilityResult = { eligible: true; recipient: string } | OptionalEmailIneligibleResult;
export type OptionalEmailDryRunEligibilityResult = { eligible: true } | OptionalEmailIneligibleResult;

export class OptionalEmailEligibilityService {
  readonly #policy: { sendingEnabled: boolean; recipientBasis: OptionalEmailRecipientBasis };
  readonly #recipients: OptionalEmailRecipientLookup;
  readonly #preferences: OptionalEmailPreferenceLookup;
  readonly #activationStates: OptionalEmailActivationStateLookup;

  constructor(input: {
    policy: { sendingEnabled: boolean; recipientBasis: OptionalEmailRecipientBasis };
    recipients: OptionalEmailRecipientLookup;
    preferences: OptionalEmailPreferenceLookup;
    activationStates: OptionalEmailActivationStateLookup;
  }) {
    this.#policy = input.policy;
    this.#recipients = input.recipients;
    this.#preferences = input.preferences;
    this.#activationStates = input.activationStates;
  }

  async evaluate(input: {
    userId: string;
    reminderKind: OptionalEmailReminderKind;
  }): Promise<OptionalEmailEligibilityResult> {
    return this.#evaluate(input, true);
  }

  async evaluateDryRun(input: {
    userId: string;
    reminderKind: OptionalEmailReminderKind;
  }): Promise<OptionalEmailDryRunEligibilityResult> {
    const result = await this.#evaluate(input, false);
    return result.eligible ? { eligible: true } : result;
  }

  async #evaluate(
    input: { userId: string; reminderKind: OptionalEmailReminderKind },
    enforceSendingEnabled: boolean,
  ): Promise<OptionalEmailEligibilityResult> {
    if (enforceSendingEnabled && !this.#policy.sendingEnabled) {
      return { eligible: false, reason: OptionalEmailSendBlockReason.SendingDisabled };
    }

    if (this.#policy.recipientBasis !== OptionalEmailRecipientBasis.AccountActivityApproved) {
      return { eligible: false, reason: OptionalEmailSendBlockReason.RecipientBasisUnapproved };
    }

    const preferenceBlockReason = await this.#preferences.findBlockReason({ userId: input.userId });
    if (preferenceBlockReason === OptionalEmailBlockReason.Unsubscribed) {
      return { eligible: false, reason: OptionalEmailSendBlockReason.Unsubscribed };
    }

    if (preferenceBlockReason === OptionalEmailBlockReason.Suppressed) {
      return { eligible: false, reason: OptionalEmailSendBlockReason.Suppressed };
    }

    const activationState = await this.#activationStates.findByUserId({ userId: input.userId });
    if (input.reminderKind === OptionalEmailReminderKind.BridgeSetup && activationState?.bridgeSetupAt) {
      return { eligible: false, reason: OptionalEmailSendBlockReason.MilestoneCompleted };
    }

    if (input.reminderKind === OptionalEmailReminderKind.FirstSession) {
      if (activationState?.firstSessionAt) {
        return { eligible: false, reason: OptionalEmailSendBlockReason.MilestoneCompleted };
      }

      if (!activationState?.bridgeSetupAt) {
        return { eligible: false, reason: OptionalEmailSendBlockReason.PrerequisiteIncomplete };
      }
    }

    const recipient = await this.#recipients.resolve({ userId: input.userId });
    switch (recipient.status) {
      case OptionalEmailRecipientStatus.Unique:
        return { eligible: true, recipient: recipient.email };
      case OptionalEmailRecipientStatus.MissingUser:
        return { eligible: false, reason: OptionalEmailSendBlockReason.MissingUser };
      case OptionalEmailRecipientStatus.MissingRecipient:
        return { eligible: false, reason: OptionalEmailSendBlockReason.MissingRecipient };
      case OptionalEmailRecipientStatus.AmbiguousRecipient:
        return { eligible: false, reason: OptionalEmailSendBlockReason.AmbiguousRecipient };
    }
  }
}

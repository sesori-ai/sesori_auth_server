import {
  OptionalEmailBlockReason,
  OptionalEmailRecipientBasis,
  OptionalEmailReminderKind,
  OptionalEmailSendBlockReason,
} from "../types/optional-email.js";

export interface OptionalEmailPreferenceLookup {
  findBlockReason(input: { userId: string }): Promise<OptionalEmailBlockReason | null>;
}

export type OptionalEmailActivationStateSnapshot = {
  bridgeSetupAt: Date | null;
  firstSessionAt: Date | null;
};

export interface OptionalEmailActivationStateLookup {
  findByUserId(input: { userId: string }): Promise<OptionalEmailActivationStateSnapshot | null>;
}

export type OptionalEmailIneligibleResult = { eligible: false; reason: OptionalEmailSendBlockReason };
export type OptionalEmailEligibilityResult = OptionalEmailIneligibleResult;
export type OptionalEmailDryRunEligibilityResult = OptionalEmailIneligibleResult;

export class OptionalEmailEligibilityService {
  readonly #policy: { sendingEnabled: boolean; recipientBasis: OptionalEmailRecipientBasis };
  readonly #preferences: OptionalEmailPreferenceLookup;
  readonly #activationStates: OptionalEmailActivationStateLookup;

  constructor(input: {
    policy: { sendingEnabled: boolean; recipientBasis: OptionalEmailRecipientBasis };
    preferences: OptionalEmailPreferenceLookup;
    activationStates: OptionalEmailActivationStateLookup;
  }) {
    this.#policy = input.policy;
    this.#preferences = input.preferences;
    this.#activationStates = input.activationStates;
  }

  async evaluate(input: {
    userId: string;
    reminderKind: OptionalEmailReminderKind;
  }): Promise<OptionalEmailEligibilityResult> {
    return this.#evaluate(input, { enforceSendingEnabled: true });
  }

  async evaluateDryRun(input: {
    userId: string;
    reminderKind: OptionalEmailReminderKind;
    activationState: OptionalEmailActivationStateSnapshot | null;
  }): Promise<OptionalEmailDryRunEligibilityResult> {
    return this.#evaluate(input, {
      enforceSendingEnabled: false,
      activationState: input.activationState,
    });
  }

  async #evaluate(
    input: { userId: string; reminderKind: OptionalEmailReminderKind },
    options:
      | { enforceSendingEnabled: true }
      | { enforceSendingEnabled: false; activationState: OptionalEmailActivationStateSnapshot | null },
  ): Promise<OptionalEmailEligibilityResult> {
    if (options.enforceSendingEnabled && !this.#policy.sendingEnabled) {
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

    const activationState =
      "activationState" in options
        ? options.activationState
        : await this.#activationStates.findByUserId({ userId: input.userId });
    if (!activationState) {
      return { eligible: false, reason: OptionalEmailSendBlockReason.MissingUser };
    }

    if (input.reminderKind === OptionalEmailReminderKind.BridgeSetup && activationState.bridgeSetupAt) {
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

    return { eligible: false, reason: OptionalEmailSendBlockReason.RecipientSafetyUnverified };
  }
}

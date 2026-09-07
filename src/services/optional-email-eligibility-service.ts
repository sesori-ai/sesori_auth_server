import type { ActivationState } from "../models/documents.js";
import type { OptionalEmailBlockReason, OptionalEmailRecipientBasis } from "../types/optional-email.js";
import { OptionalEmailRecipientBasis as RecipientBasis, OptionalEmailReminderKind } from "../types/optional-email.js";

export type OptionalEmailRecipientResolution =
  | { status: "unique"; email: string }
  | { status: "missing_user" | "missing_recipient" | "ambiguous_recipient" };

export interface OptionalEmailRecipientLookup {
  resolve(input: { userId: string }): Promise<OptionalEmailRecipientResolution>;
}

export interface OptionalEmailPreferenceLookup {
  findBlockReason(input: { userId: string }): Promise<OptionalEmailBlockReason | null>;
}

export interface OptionalEmailActivationStateLookup {
  findByUserId(userId: string): Promise<ActivationState | null>;
}

export type OptionalEmailEligibilityResult =
  | { eligible: true; recipient: string }
  | {
      eligible: false;
      reason:
        | "sending_disabled"
        | "recipient_basis_unapproved"
        | "missing_user"
        | "missing_recipient"
        | "ambiguous_recipient"
        | "milestone_completed"
        | "prerequisite_incomplete"
        | OptionalEmailBlockReason;
    };

export class OptionalEmailEligibilityService {
  readonly #policy: { sendingEnabled: boolean; recipientBasis: OptionalEmailRecipientBasis };
  readonly #preferences: OptionalEmailPreferenceLookup;
  readonly #activationStates: OptionalEmailActivationStateLookup;
  readonly #recipients: OptionalEmailRecipientLookup;

  constructor(input: {
    policy: { sendingEnabled: boolean; recipientBasis: OptionalEmailRecipientBasis };
    recipients: OptionalEmailRecipientLookup;
    preferences: OptionalEmailPreferenceLookup;
    activationStates: OptionalEmailActivationStateLookup;
  }) {
    this.#policy = input.policy;
    this.#preferences = input.preferences;
    this.#activationStates = input.activationStates;
    this.#recipients = input.recipients;
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
  }): Promise<OptionalEmailEligibilityResult> {
    return this.#evaluate(input, false);
  }

  async #evaluate(
    _input: { userId: string; reminderKind: OptionalEmailReminderKind },
    enforceSendingEnabled: boolean,
  ): Promise<OptionalEmailEligibilityResult> {
    if (enforceSendingEnabled && !this.#policy.sendingEnabled) {
      return { eligible: false, reason: "sending_disabled" };
    }
    if (this.#policy.recipientBasis !== RecipientBasis.AccountActivityApproved) {
      return { eligible: false, reason: "recipient_basis_unapproved" };
    }
    const blockReason = await this.#preferences.findBlockReason({ userId: _input.userId });
    if (blockReason) {
      return { eligible: false, reason: blockReason };
    }
    const state = await this.#activationStates.findByUserId(_input.userId);
    if (_input.reminderKind === OptionalEmailReminderKind.BridgeSetup && state?.bridgeSetupAt) {
      return { eligible: false, reason: "milestone_completed" };
    }
    if (_input.reminderKind === OptionalEmailReminderKind.FirstSession) {
      if (state?.firstSessionAt) {
        return { eligible: false, reason: "milestone_completed" };
      }
      if (!state?.bridgeSetupAt) {
        return { eligible: false, reason: "prerequisite_incomplete" };
      }
    }
    const recipient = await this.#recipients.resolve({ userId: _input.userId });
    if (recipient.status !== "unique") {
      return { eligible: false, reason: recipient.status };
    }
    return { eligible: true, recipient: recipient.email };
  }
}

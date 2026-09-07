import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OptionalEmailEligibilityService } from "../../src/services/optional-email-eligibility-service.js";
import {
  OptionalEmailBlockReason,
  OptionalEmailRecipientBasis,
  OptionalEmailRecipientStatus,
  OptionalEmailReminderKind,
  OptionalEmailSendBlockReason,
} from "../../src/types/optional-email.js";

describe("OptionalEmailEligibilityService", () => {
  it("stops before all downstream reads when sending or the recipient basis is disabled", async () => {
    for (const testCase of [
      {
        sendingEnabled: false,
        recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
        reason: OptionalEmailSendBlockReason.SendingDisabled,
      },
      {
        sendingEnabled: true,
        recipientBasis: OptionalEmailRecipientBasis.Unapproved,
        reason: OptionalEmailSendBlockReason.RecipientBasisUnapproved,
      },
    ]) {
      let downstreamReads = 0;
      const service = new OptionalEmailEligibilityService({
        policy: {
          sendingEnabled: testCase.sendingEnabled,
          recipientBasis: testCase.recipientBasis,
        },
        recipients: {
          resolve: async () => {
            downstreamReads += 1;
            return { status: OptionalEmailRecipientStatus.MissingUser };
          },
        },
        preferences: {
          findBlockReason: async () => {
            downstreamReads += 1;
            return null;
          },
        },
        activationStates: {
          findByUserId: async () => {
            downstreamReads += 1;
            return null;
          },
        },
      });

      assert.deepEqual(
        await service.evaluate({
          userId: "000000000000000000000001",
          reminderKind: OptionalEmailReminderKind.BridgeSetup,
        }),
        { eligible: false, reason: testCase.reason },
      );
      assert.equal(downstreamReads, 0);
    }
  });

  it("blocks durable unsubscribe and suppression before milestone or recipient reads", async () => {
    for (const blockReason of [OptionalEmailBlockReason.Unsubscribed, OptionalEmailBlockReason.Suppressed]) {
      let downstreamReads = 0;
      const service = new OptionalEmailEligibilityService({
        policy: {
          sendingEnabled: true,
          recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
        },
        preferences: { findBlockReason: async () => blockReason },
        activationStates: {
          findByUserId: async () => {
            downstreamReads += 1;
            return null;
          },
        },
        recipients: {
          resolve: async () => {
            downstreamReads += 1;
            return { status: OptionalEmailRecipientStatus.MissingUser };
          },
        },
      });

      assert.deepEqual(
        await service.evaluate({
          userId: "000000000000000000000001",
          reminderKind: OptionalEmailReminderKind.BridgeSetup,
        }),
        { eligible: false, reason: blockReason },
      );
      assert.equal(downstreamReads, 0);
    }
  });

  it("stops obsolete setup reminders from canonical activation milestones", async () => {
    const cases = [
      {
        reminderKind: OptionalEmailReminderKind.BridgeSetup,
        activationState: { bridgeSetupAt: new Date(1), firstSessionAt: null },
        reason: OptionalEmailSendBlockReason.MilestoneCompleted,
      },
      {
        reminderKind: OptionalEmailReminderKind.FirstSession,
        activationState: { bridgeSetupAt: new Date(1), firstSessionAt: new Date(2) },
        reason: OptionalEmailSendBlockReason.MilestoneCompleted,
      },
      {
        reminderKind: OptionalEmailReminderKind.FirstSession,
        activationState: { bridgeSetupAt: null, firstSessionAt: null },
        reason: OptionalEmailSendBlockReason.PrerequisiteIncomplete,
      },
    ];

    for (const testCase of cases) {
      let recipientReads = 0;
      const service = new OptionalEmailEligibilityService({
        policy: {
          sendingEnabled: true,
          recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
        },
        preferences: { findBlockReason: async () => null },
        activationStates: { findByUserId: async () => testCase.activationState },
        recipients: {
          resolve: async () => {
            recipientReads += 1;
            return { status: OptionalEmailRecipientStatus.MissingUser };
          },
        },
      });

      assert.deepEqual(
        await service.evaluate({
          userId: "000000000000000000000001",
          reminderKind: testCase.reminderKind,
        }),
        { eligible: false, reason: testCase.reason },
      );
      assert.equal(recipientReads, 0);
    }
  });

  it("fails closed unless account identities resolve to one normalized recipient", async () => {
    const cases = [
      {
        resolution: { status: OptionalEmailRecipientStatus.MissingUser } as const,
        result: { eligible: false, reason: OptionalEmailSendBlockReason.MissingUser } as const,
      },
      {
        resolution: { status: OptionalEmailRecipientStatus.MissingRecipient } as const,
        result: { eligible: false, reason: OptionalEmailSendBlockReason.MissingRecipient } as const,
      },
      {
        resolution: { status: OptionalEmailRecipientStatus.AmbiguousRecipient } as const,
        result: { eligible: false, reason: OptionalEmailSendBlockReason.AmbiguousRecipient } as const,
      },
      {
        resolution: { status: OptionalEmailRecipientStatus.Unique, email: "one@example.test" } as const,
        result: { eligible: true, recipient: "one@example.test" } as const,
      },
    ];

    for (const testCase of cases) {
      const service = new OptionalEmailEligibilityService({
        policy: {
          sendingEnabled: true,
          recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
        },
        preferences: { findBlockReason: async () => null },
        activationStates: { findByUserId: async () => null },
        recipients: { resolve: async () => testCase.resolution },
      });

      assert.deepEqual(
        await service.evaluate({
          userId: "000000000000000000000001",
          reminderKind: OptionalEmailReminderKind.BridgeSetup,
        }),
        testCase.result,
      );
    }
  });

  it("ignores only the send switch in dry-run and never returns the recipient", async () => {
    let recipientReads = 0;
    const input = {
      userId: "000000000000000000000001",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    };
    const approved = new OptionalEmailEligibilityService({
      policy: {
        sendingEnabled: false,
        recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
      },
      preferences: { findBlockReason: async () => null },
      activationStates: { findByUserId: async () => null },
      recipients: {
        resolve: async () => {
          recipientReads += 1;
          return { status: OptionalEmailRecipientStatus.Unique, email: "must-not-escape@example.test" };
        },
      },
    });

    assert.deepEqual(await approved.evaluate(input), {
      eligible: false,
      reason: OptionalEmailSendBlockReason.SendingDisabled,
    });
    assert.deepEqual(await approved.evaluateDryRun(input), { eligible: true });
    assert.equal(recipientReads, 1);
    assert.doesNotMatch(JSON.stringify(await approved.evaluateDryRun(input)), /@|must-not-escape/);

    const unapproved = new OptionalEmailEligibilityService({
      policy: { sendingEnabled: false, recipientBasis: OptionalEmailRecipientBasis.Unapproved },
      preferences: { findBlockReason: async () => null },
      activationStates: { findByUserId: async () => null },
      recipients: {
        resolve: async () => {
          throw new Error("recipient must not be read without an approved basis");
        },
      },
    });
    assert.deepEqual(await unapproved.evaluateDryRun(input), {
      eligible: false,
      reason: OptionalEmailSendBlockReason.RecipientBasisUnapproved,
    });
  });

  it("rechecks durable preference and milestone state on every evaluation", async () => {
    let blockReason: OptionalEmailBlockReason | null = null;
    let activationState: { bridgeSetupAt: Date | null; firstSessionAt: Date | null } | null = null;
    const service = new OptionalEmailEligibilityService({
      policy: {
        sendingEnabled: true,
        recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
      },
      preferences: { findBlockReason: async () => blockReason },
      activationStates: { findByUserId: async () => activationState },
      recipients: {
        resolve: async () => ({
          status: OptionalEmailRecipientStatus.Unique,
          email: "one@example.test",
        }),
      },
    });
    const bridgeInput = {
      userId: "000000000000000000000001",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    };

    assert.deepEqual(await service.evaluate(bridgeInput), { eligible: true, recipient: "one@example.test" });
    blockReason = OptionalEmailBlockReason.Unsubscribed;
    assert.deepEqual(await service.evaluate(bridgeInput), {
      eligible: false,
      reason: OptionalEmailSendBlockReason.Unsubscribed,
    });

    blockReason = null;
    activationState = { bridgeSetupAt: new Date(1), firstSessionAt: null };
    assert.deepEqual(await service.evaluate(bridgeInput), {
      eligible: false,
      reason: OptionalEmailSendBlockReason.MilestoneCompleted,
    });

    const sessionInput = { ...bridgeInput, reminderKind: OptionalEmailReminderKind.FirstSession };
    assert.deepEqual(await service.evaluate(sessionInput), { eligible: true, recipient: "one@example.test" });
    activationState = { bridgeSetupAt: new Date(1), firstSessionAt: new Date(2) };
    assert.deepEqual(await service.evaluate(sessionInput), {
      eligible: false,
      reason: OptionalEmailSendBlockReason.MilestoneCompleted,
    });
  });
});

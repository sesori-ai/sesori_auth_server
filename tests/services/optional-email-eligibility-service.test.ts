import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OptionalEmailEligibilityService } from "../../src/services/optional-email-eligibility-service.js";
import {
  OptionalEmailBlockReason,
  OptionalEmailRecipientBasis,
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

  it("blocks durable unsubscribe and suppression before milestone reads", async () => {
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

  it("blocks normal eligibility when the current user no longer exists", async () => {
    const service = new OptionalEmailEligibilityService({
      policy: {
        sendingEnabled: true,
        recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
      },
      preferences: { findBlockReason: async () => null },
      activationStates: { findByUserId: async () => null },
    });

    assert.deepEqual(
      await service.evaluate({
        userId: "000000000000000000000001",
        reminderKind: OptionalEmailReminderKind.BridgeSetup,
      }),
      { eligible: false, reason: OptionalEmailSendBlockReason.MissingUser },
    );
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
      const service = new OptionalEmailEligibilityService({
        policy: {
          sendingEnabled: true,
          recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
        },
        preferences: { findBlockReason: async () => null },
        activationStates: { findByUserId: async () => testCase.activationState },
      });

      assert.deepEqual(
        await service.evaluate({
          userId: "000000000000000000000001",
          reminderKind: testCase.reminderKind,
        }),
        { eligible: false, reason: testCase.reason },
      );
    }
  });

  it("fails closed when recipient safety is unverified after the policy, preference, and milestone gates", async () => {
    const service = new OptionalEmailEligibilityService({
      policy: {
        sendingEnabled: true,
        recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
      },
      preferences: { findBlockReason: async () => null },
      activationStates: {
        findByUserId: async () => ({ bridgeSetupAt: null, firstSessionAt: null }),
      },
    });

    assert.deepEqual(
      await service.evaluate({
        userId: "000000000000000000000001",
        reminderKind: OptionalEmailReminderKind.BridgeSetup,
      }),
      { eligible: false, reason: OptionalEmailSendBlockReason.RecipientSafetyUnverified },
    );
  });

  it("ignores only the send switch in dry-run and otherwise fails closed", async () => {
    const input = {
      userId: "000000000000000000000001",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
      activationState: { bridgeSetupAt: null, firstSessionAt: null },
    };
    const approved = new OptionalEmailEligibilityService({
      policy: {
        sendingEnabled: false,
        recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
      },
      preferences: { findBlockReason: async () => null },
      activationStates: { findByUserId: async () => null },
    });

    assert.deepEqual(await approved.evaluate(input), {
      eligible: false,
      reason: OptionalEmailSendBlockReason.SendingDisabled,
    });
    assert.deepEqual(await approved.evaluateDryRun(input), {
      eligible: false,
      reason: OptionalEmailSendBlockReason.RecipientSafetyUnverified,
    });
    assert.doesNotMatch(JSON.stringify(await approved.evaluateDryRun(input)), /"(?:recipient|email)"\s*:|@/i);

    const unapproved = new OptionalEmailEligibilityService({
      policy: { sendingEnabled: false, recipientBasis: OptionalEmailRecipientBasis.Unapproved },
      preferences: { findBlockReason: async () => null },
      activationStates: { findByUserId: async () => null },
    });
    assert.deepEqual(await unapproved.evaluateDryRun(input), {
      eligible: false,
      reason: OptionalEmailSendBlockReason.RecipientBasisUnapproved,
    });
  });

  it("uses the caller activation snapshot for dry-run eligibility", async () => {
    let activationReads = 0;
    const service = new OptionalEmailEligibilityService({
      policy: {
        sendingEnabled: false,
        recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
      },
      preferences: { findBlockReason: async () => null },
      activationStates: {
        findByUserId: async () => {
          activationReads += 1;
          return { bridgeSetupAt: new Date(1), firstSessionAt: null };
        },
      },
    });

    assert.deepEqual(
      await service.evaluateDryRun({
        userId: "000000000000000000000001",
        reminderKind: OptionalEmailReminderKind.BridgeSetup,
        activationState: { bridgeSetupAt: null, firstSessionAt: null },
      }),
      { eligible: false, reason: OptionalEmailSendBlockReason.RecipientSafetyUnverified },
    );
    assert.equal(activationReads, 0);
  });

  it("rechecks durable preference and milestone state on every evaluation", async () => {
    let blockReason: OptionalEmailBlockReason | null = null;
    let activationState: { bridgeSetupAt: Date | null; firstSessionAt: Date | null } | null = {
      bridgeSetupAt: null,
      firstSessionAt: null,
    };
    const service = new OptionalEmailEligibilityService({
      policy: {
        sendingEnabled: true,
        recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
      },
      preferences: { findBlockReason: async () => blockReason },
      activationStates: { findByUserId: async () => activationState },
    });
    const bridgeInput = {
      userId: "000000000000000000000001",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    };

    assert.deepEqual(await service.evaluate(bridgeInput), {
      eligible: false,
      reason: OptionalEmailSendBlockReason.RecipientSafetyUnverified,
    });
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
    assert.deepEqual(await service.evaluate(sessionInput), {
      eligible: false,
      reason: OptionalEmailSendBlockReason.RecipientSafetyUnverified,
    });
    activationState = { bridgeSetupAt: new Date(1), firstSessionAt: new Date(2) };
    assert.deepEqual(await service.evaluate(sessionInput), {
      eligible: false,
      reason: OptionalEmailSendBlockReason.MilestoneCompleted,
    });
  });
});

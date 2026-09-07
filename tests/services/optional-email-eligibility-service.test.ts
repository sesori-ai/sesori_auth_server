import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ObjectId } from "mongodb";
import type { ActivationState } from "../../src/models/documents.js";
import { OptionalEmailEligibilityService } from "../../src/services/optional-email-eligibility-service.js";
import {
  OptionalEmailBlockReason,
  OptionalEmailRecipientBasis,
  OptionalEmailReminderKind,
} from "../../src/types/optional-email.js";

describe("OptionalEmailEligibilityService", () => {
  it("fails closed before user or email lookup when recipient basis is unapproved", async () => {
    let downstreamReads = 0;
    const service = new OptionalEmailEligibilityService({
      policy: {
        sendingEnabled: true,
        recipientBasis: OptionalEmailRecipientBasis.Unapproved,
      },
      recipients: {
        resolve: async () => {
          downstreamReads += 1;
          return { status: "unique", email: "should-not-be-read@example.test" } as const;
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

    const result = await service.evaluate({
      userId: "000000000000000000000001",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    });

    assert.deepEqual(result, { eligible: false, reason: "recipient_basis_unapproved" });
    assert.equal(downstreamReads, 0);
  });

  it("blocks all real sends before downstream reads while sending is disabled", async () => {
    let downstreamReads = 0;
    const read = async () => {
      downstreamReads += 1;
      return null;
    };
    const service = new OptionalEmailEligibilityService({
      policy: {
        sendingEnabled: false,
        recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
      },
      recipients: { resolve: read as never },
      preferences: { findBlockReason: read as never },
      activationStates: { findByUserId: read },
    });

    const result = await service.evaluate({
      userId: "000000000000000000000001",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    });

    assert.deepEqual(result, { eligible: false, reason: "sending_disabled" });
    assert.equal(downstreamReads, 0);
  });

  it("blocks unsubscribe and suppression before resolving a recipient address", async () => {
    for (const blockReason of [OptionalEmailBlockReason.Unsubscribed, OptionalEmailBlockReason.Suppressed]) {
      let recipientReads = 0;
      const service = new OptionalEmailEligibilityService({
        policy: {
          sendingEnabled: true,
          recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
        },
        recipients: {
          resolve: async () => {
            recipientReads += 1;
            return { status: "unique", email: "should-not-be-read@example.test" };
          },
        },
        preferences: { findBlockReason: async () => blockReason },
        activationStates: { findByUserId: async () => null },
      });

      assert.deepEqual(
        await service.evaluate({
          userId: "000000000000000000000001",
          reminderKind: OptionalEmailReminderKind.BridgeSetup,
        }),
        { eligible: false, reason: blockReason },
      );
      assert.equal(recipientReads, 0);
    }
  });

  it("blocks milestone-obsolete reminders and unmet session prerequisites before recipient lookup", async () => {
    const state = (input: { bridgeSetupAt: Date | null; firstSessionAt: Date | null }): ActivationState => ({
      _id: new ObjectId(),
      userId: new ObjectId("000000000000000000000001"),
      mobileSetupAt: null,
      bridgeSetupAt: input.bridgeSetupAt,
      firstSessionAt: input.firstSessionAt,
      bridgeReminderBaseAt: null,
      sessionReminderBaseAt: null,
      bridgeReminder1SentAt: null,
      bridgeReminder2SentAt: null,
      sessionReminderSentAt: null,
      backfilledAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const cases = [
      {
        reminderKind: OptionalEmailReminderKind.BridgeSetup,
        activation: state({ bridgeSetupAt: new Date(1), firstSessionAt: null }),
        reason: "milestone_completed",
      },
      {
        reminderKind: OptionalEmailReminderKind.FirstSession,
        activation: state({ bridgeSetupAt: new Date(1), firstSessionAt: new Date(2) }),
        reason: "milestone_completed",
      },
      {
        reminderKind: OptionalEmailReminderKind.FirstSession,
        activation: state({ bridgeSetupAt: null, firstSessionAt: null }),
        reason: "prerequisite_incomplete",
      },
    ] as const;

    for (const testCase of cases) {
      let recipientReads = 0;
      const service = new OptionalEmailEligibilityService({
        policy: { sendingEnabled: true, recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved },
        recipients: {
          resolve: async () => {
            recipientReads += 1;
            return { status: "unique", email: "should-not-be-read@example.test" };
          },
        },
        preferences: { findBlockReason: async () => null },
        activationStates: { findByUserId: async () => testCase.activation },
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

  it("fails closed for non-unique recipient resolution and returns only one eligible address", async () => {
    const cases = [
      { resolution: { status: "missing_user" } as const, result: { eligible: false, reason: "missing_user" } },
      {
        resolution: { status: "missing_recipient" } as const,
        result: { eligible: false, reason: "missing_recipient" },
      },
      {
        resolution: { status: "ambiguous_recipient" } as const,
        result: { eligible: false, reason: "ambiguous_recipient" },
      },
      {
        resolution: { status: "unique", email: "one@example.test" } as const,
        result: { eligible: true, recipient: "one@example.test" },
      },
    ] as const;

    for (const testCase of cases) {
      const service = new OptionalEmailEligibilityService({
        policy: { sendingEnabled: true, recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved },
        recipients: { resolve: async () => testCase.resolution },
        preferences: { findBlockReason: async () => null },
        activationStates: { findByUserId: async () => null },
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

  it("ignores only the operational send switch during dry-run", async () => {
    let recipientReads = 0;
    const approved = new OptionalEmailEligibilityService({
      policy: {
        sendingEnabled: false,
        recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
      },
      recipients: {
        resolve: async () => {
          recipientReads += 1;
          return { status: "unique" as const, email: "dry-run@example.test" };
        },
      },
      preferences: { findBlockReason: async () => null },
      activationStates: { findByUserId: async () => null },
    });
    const input = {
      userId: "000000000000000000000001",
      reminderKind: OptionalEmailReminderKind.BridgeSetup,
    };

    assert.deepEqual(await approved.evaluate(input), { eligible: false, reason: "sending_disabled" });
    assert.deepEqual(await approved.evaluateDryRun(input), {
      eligible: true,
      recipient: "dry-run@example.test",
    });
    assert.equal(recipientReads, 1);

    const unapproved = new OptionalEmailEligibilityService({
      policy: {
        sendingEnabled: false,
        recipientBasis: OptionalEmailRecipientBasis.Unapproved,
      },
      recipients: {
        resolve: async () => {
          recipientReads += 1;
          return { status: "unique" as const, email: "must-not-read@example.test" };
        },
      },
      preferences: { findBlockReason: async () => null },
      activationStates: { findByUserId: async () => null },
    });
    assert.deepEqual(await unapproved.evaluateDryRun(input), {
      eligible: false,
      reason: "recipient_basis_unapproved",
    });
    assert.equal(recipientReads, 1);
  });
});

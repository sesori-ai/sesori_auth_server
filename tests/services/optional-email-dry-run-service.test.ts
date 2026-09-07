import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OptionalEmailDryRunService } from "../../src/services/optional-email-dry-run-service.js";
import {
  OptionalEmailDryRunMode,
  OptionalEmailRecipientBasis,
  OptionalEmailReminderKind,
  OptionalEmailSendBlockReason,
} from "../../src/types/optional-email.js";

describe("OptionalEmailDryRunService", () => {
  it("rejects an invalid batch limit before repository reads", async () => {
    let repositoryReads = 0;
    const service = new OptionalEmailDryRunService({
      users: {
        findIdBatch: async () => {
          repositoryReads += 1;
          return [];
        },
      },
      activationStates: { findByUserId: async () => null },
      eligibility: {
        evaluateDryRun: async () => ({
          eligible: false,
          reason: OptionalEmailSendBlockReason.RecipientSafetyUnverified,
        }),
      },
      policy: {
        sendingEnabled: false,
        recipientBasis: OptionalEmailRecipientBasis.Unapproved,
        dailyCap: 80,
      },
    });

    for (const batchLimit of [0, 1.5, 1_001]) {
      await assert.rejects(() => service.run({ batchLimit }), /InvalidOptionalEmailDryRunBatchLimit/);
    }
    assert.equal(repositoryReads, 0);
  });

  it("returns fixed-cohort aggregate stage and block counts without identifiers or addresses", async () => {
    const userIds = ["000000000000000000000001", "000000000000000000000002", "000000000000000000000003"];
    const states = new Map([
      [userIds[0], { bridgeSetupAt: null, firstSessionAt: null }],
      [userIds[1], { bridgeSetupAt: new Date("2026-09-02T00:00:00.000Z"), firstSessionAt: null }],
      [
        userIds[2],
        {
          bridgeSetupAt: new Date("2026-09-02T00:00:00.000Z"),
          firstSessionAt: new Date("2026-09-03T00:00:00.000Z"),
        },
      ],
    ]);
    const pageInputs: unknown[] = [];
    const eligibilityInputs: unknown[] = [];
    let page = 0;
    const service = new OptionalEmailDryRunService({
      users: {
        findIdBatch: async (input) => {
          pageInputs.push(input);
          page += 1;
          return page === 1 ? userIds.slice(0, 2) : page === 2 ? userIds.slice(2) : [];
        },
      },
      activationStates: {
        findByUserId: async ({ userId }) => states.get(userId) ?? null,
      },
      eligibility: {
        evaluateDryRun: async (input) => {
          eligibilityInputs.push(input);
          return input.reminderKind === OptionalEmailReminderKind.BridgeSetup
            ? { eligible: false, reason: OptionalEmailSendBlockReason.RecipientSafetyUnverified }
            : { eligible: false, reason: OptionalEmailSendBlockReason.Suppressed };
        },
      },
      policy: {
        sendingEnabled: false,
        recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
        dailyCap: 80,
      },
      clock: () => new Date("2026-09-06T16:00:00.000Z"),
    });

    const report = await service.run({ batchLimit: 2 });

    assert.deepEqual(report, {
      mode: OptionalEmailDryRunMode.DryRun,
      generatedAt: "2026-09-06T16:00:00.000Z",
      sendingEnabled: false,
      recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved,
      dailyCap: 80,
      usersScanned: 3,
      candidates: 2,
      segments: {
        [OptionalEmailReminderKind.BridgeSetup]: 1,
        [OptionalEmailReminderKind.FirstSession]: 1,
      },
      eligible: 0,
      blockedByReason: {
        [OptionalEmailSendBlockReason.RecipientSafetyUnverified]: 1,
        [OptionalEmailSendBlockReason.Suppressed]: 1,
      },
    });
    assert.deepEqual(pageInputs, [
      { afterUserId: null, batchLimit: 2, createdAtOrBefore: new Date("2026-09-06T16:00:00.000Z") },
      { afterUserId: userIds[1], batchLimit: 2, createdAtOrBefore: new Date("2026-09-06T16:00:00.000Z") },
    ]);
    assert.deepEqual(eligibilityInputs, [
      {
        userId: userIds[0],
        reminderKind: OptionalEmailReminderKind.BridgeSetup,
        activationState: states.get(userIds[0]),
      },
      {
        userId: userIds[1],
        reminderKind: OptionalEmailReminderKind.FirstSession,
        activationState: states.get(userIds[1]),
      },
    ]);

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /@|example\.test/i);
    for (const userId of userIds) {
      assert.doesNotMatch(serialized, new RegExp(userId));
    }
  });
});

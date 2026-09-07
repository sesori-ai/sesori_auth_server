import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ObjectId } from "mongodb";
import type { ActivationState } from "../../src/models/documents.js";
import { OptionalEmailDryRunService } from "../../src/services/optional-email-dry-run-service.js";
import { OptionalEmailRecipientBasis, OptionalEmailReminderKind } from "../../src/types/optional-email.js";

function activationState(input: { userId: string; bridgeSetupAt?: Date; firstSessionAt?: Date }): ActivationState {
  const createdAt = new Date("2026-09-01T00:00:00.000Z");
  return {
    _id: new ObjectId(),
    userId: new ObjectId(input.userId),
    mobileSetupAt: null,
    bridgeSetupAt: input.bridgeSetupAt ?? null,
    firstSessionAt: input.firstSessionAt ?? null,
    reminderSchedule: null,
    reminderRevision: 0,
    backfilledAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("OptionalEmailDryRunService", () => {
  it("returns aggregate segment and eligibility counts without identifiers or addresses", async () => {
    const users = [new ObjectId().toHexString(), new ObjectId().toHexString(), new ObjectId().toHexString()];
    const states = new Map<string, ActivationState | null>([
      [users[0] ?? "", null],
      [
        users[1] ?? "",
        activationState({ userId: users[1] ?? "", bridgeSetupAt: new Date("2026-09-02T00:00:00.000Z") }),
      ],
      [
        users[2] ?? "",
        activationState({
          userId: users[2] ?? "",
          bridgeSetupAt: new Date("2026-09-02T00:00:00.000Z"),
          firstSessionAt: new Date("2026-09-03T00:00:00.000Z"),
        }),
      ],
    ]);
    let page = 0;
    const service = new OptionalEmailDryRunService({
      users: {
        findIdBatch: async () => {
          page += 1;
          return page === 1 ? users.slice(0, 2) : page === 2 ? users.slice(2) : [];
        },
      },
      activationStates: {
        findByUserId: async (userId) => states.get(userId) ?? null,
      },
      eligibility: {
        evaluateDryRun: async ({ reminderKind }) =>
          reminderKind === OptionalEmailReminderKind.BridgeSetup
            ? { eligible: true as const, recipient: "must-not-escape@example.test" }
            : { eligible: false as const, reason: "suppressed" },
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
      mode: "dry_run",
      generatedAt: "2026-09-06T16:00:00.000Z",
      sendingEnabled: false,
      recipientBasis: "account_activity_approved",
      dailyCap: 80,
      usersScanned: 3,
      candidates: 2,
      segments: { bridge_setup: 1, first_session: 1 },
      eligible: 1,
      blockedByReason: { suppressed: 1 },
    });
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /@|must-not-escape/);
    for (const userId of users) {
      assert.doesNotMatch(serialized, new RegExp(userId));
    }
  });
});

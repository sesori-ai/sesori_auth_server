import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ObjectId } from "mongodb";
import { BridgePlatform, BridgeStatus } from "../../src/models/bridge.js";
import { DevicePlatform } from "../../src/models/device.js";
import type { ActivationState, Bridge, DailyUsage, DeviceToken } from "../../src/models/documents.js";
import { ActivationStateRepository } from "../../src/repositories/activation-state-repo.js";
import { BridgeRepository } from "../../src/repositories/bridge-repo.js";
import { DailyUsageRepository } from "../../src/repositories/daily-usage-repo.js";
import { DeviceTokenRepository } from "../../src/repositories/device-token-repo.js";
import { UserRepository } from "../../src/repositories/user-repo.js";
import {
  ActivationBackfillMode,
  ActivationBackfillReminder,
  ActivationBackfillService,
  ActivationBackfillStage,
  deterministicActivationJitterMs,
} from "../../src/services/activation-backfill-service.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

const BACKFILL_AT = new Date("2030-07-16T10:00:00.000Z");
const JITTER_WINDOW_MS = 3_600_000;

describe("ActivationBackfillService", () => {
  let ctx: TestContext;
  let activationStateRepo: ActivationStateRepository;
  let service: ActivationBackfillService;

  before(async () => {
    ctx = await createTestApp();
    activationStateRepo = new ActivationStateRepository(ctx.dbAccessor);
    service = new ActivationBackfillService({
      userRepo: new UserRepository(ctx.dbAccessor),
      activationStateRepo,
      bridgeRepo: new BridgeRepository(ctx.dbAccessor),
      dailyUsageRepo: new DailyUsageRepository(ctx.dbAccessor),
      deviceTokenRepo: new DeviceTokenRepository(ctx.dbAccessor),
    });
  });

  after(async () => {
    await ctx.cleanup();
  });

  async function seedToken(
    userId: string,
    createdAt: Date,
    platform: DevicePlatform = DevicePlatform.ios,
  ): Promise<void> {
    await ctx.dbAccessor.getCollection<DeviceToken>(MongoDbDatabase.Auth, AuthDbCollection.DeviceTokens).insertOne({
      _id: new ObjectId(),
      userId: new ObjectId(userId),
      token: `backfill-token-${userId}`,
      platform,
      createdAt,
      updatedAt: createdAt,
    });
  }

  async function seedBridge(userId: string, addedAt: Date, revoked: boolean): Promise<void> {
    await ctx.dbAccessor.getCollection<Bridge>(MongoDbDatabase.Auth, AuthDbCollection.Bridges).insertOne({
      _id: new ObjectId(),
      bridgeId: `br_${userId}`,
      userId: new ObjectId(userId),
      name: "Historical bridge",
      platform: BridgePlatform.macos,
      status: BridgeStatus.inactive,
      addedAt,
      lastSeenAt: null,
      lastSeenIp: null,
      revokedAt: revoked ? addedAt : null,
      createdAt: addedAt,
      updatedAt: addedAt,
    });
  }

  async function seedSession(userId: string, createdAt: Date): Promise<void> {
    await ctx.dbAccessor.getCollection<DailyUsage>(MongoDbDatabase.Auth, AuthDbCollection.DailyUsage).insertOne({
      _id: new ObjectId(),
      userId: new ObjectId(userId),
      date: createdAt.toISOString().slice(0, 10),
      transcriptionSeconds: 0,
      metadataRequestCount: 1,
      createdAt,
      updatedAt: createdAt,
    });
  }

  it("previews safely, applies controlled baselines, and is idempotent", async () => {
    const noToken = await ctx.createUser();
    const bridge1 = await ctx.createUser();
    const bridge2 = await ctx.createUser();
    const session = await ctx.createUser();
    const activated = await ctx.createUser();
    const mobileAt = new Date("2026-06-01T08:00:00.000Z");
    const bridgeAt = new Date("2026-06-02T09:00:00.000Z");
    const approximateSessionAt = new Date("2026-06-03T00:00:00.000Z");
    const preciseSessionAt = new Date("2026-06-03T10:00:00.000Z");

    await seedBridge(noToken.userId, bridgeAt, true);
    for (const userId of [bridge1.userId, bridge2.userId, session.userId, activated.userId]) {
      await seedToken(userId, mobileAt);
    }
    await seedBridge(session.userId, bridgeAt, true);
    await seedBridge(activated.userId, bridgeAt, false);
    await seedSession(activated.userId, approximateSessionAt);
    await activationStateRepo.recordMilestones(
      activated.userId,
      { firstSessionAt: preciseSessionAt },
      preciseSessionAt,
    );

    const bridge2State = await activationStateRepo.createIfAbsent(bridge2.userId, mobileAt);
    const oldBaseline = new Date("2026-06-01T08:00:00.000Z");
    const reminder1SentAt = new Date("2026-06-02T08:00:00.000Z");
    await ctx.dbAccessor
      .getCollection<ActivationState>(MongoDbDatabase.Auth, AuthDbCollection.ActivationStates)
      .updateOne(
        { _id: bridge2State._id },
        { $set: { bridgeReminderBaseAt: oldBaseline, bridgeReminder1SentAt: reminder1SentAt } },
      );

    const options = {
      apply: false,
      backfillAt: BACKFILL_AT,
      batchLimit: 2,
      jitterWindowMs: JITTER_WINDOW_MS,
    };
    const completedBatchSizes: number[] = [];
    const preview = await service.run({
      ...options,
      onBatchComplete: (report) => completedBatchSizes.push(report.usersScanned),
    });

    assert.equal(preview.mode, ActivationBackfillMode.DryRun);
    assert.deepEqual(completedBatchSizes, [2, 4, 5]);
    assert.equal(preview.usersScanned, 5);
    assert.equal(preview.usersProposed, 5);
    assert.equal(preview.usersApplied, 0);
    assert.deepEqual(preview.byStage, {
      [ActivationBackfillStage.MobileIncomplete]: { proposed: 1, applied: 0 },
      [ActivationBackfillStage.BridgeIncomplete]: { proposed: 2, applied: 0 },
      [ActivationBackfillStage.SessionIncomplete]: { proposed: 1, applied: 0 },
      [ActivationBackfillStage.Activated]: { proposed: 1, applied: 0 },
    });
    assert.deepEqual(preview.byReminder, {
      [ActivationBackfillReminder.Bridge1]: { proposed: 1, applied: 0 },
      [ActivationBackfillReminder.Bridge2]: { proposed: 1, applied: 0 },
      [ActivationBackfillReminder.Session]: { proposed: 1, applied: 0 },
      [ActivationBackfillReminder.None]: { proposed: 2, applied: 0 },
    });
    assert.equal(await activationStateRepo.findByUserId(noToken.userId), null);
    assert.equal((await activationStateRepo.findByUserId(bridge2.userId))?.backfilledAt, null);

    const applied = await service.run({ ...options, apply: true });

    assert.equal(applied.mode, ActivationBackfillMode.Apply);
    assert.equal(applied.usersApplied, 5);
    assert.deepEqual(applied.byStage, {
      [ActivationBackfillStage.MobileIncomplete]: { proposed: 1, applied: 1 },
      [ActivationBackfillStage.BridgeIncomplete]: { proposed: 2, applied: 2 },
      [ActivationBackfillStage.SessionIncomplete]: { proposed: 1, applied: 1 },
      [ActivationBackfillStage.Activated]: { proposed: 1, applied: 1 },
    });
    assert.deepEqual(applied.byReminder, {
      [ActivationBackfillReminder.Bridge1]: { proposed: 1, applied: 1 },
      [ActivationBackfillReminder.Bridge2]: { proposed: 1, applied: 1 },
      [ActivationBackfillReminder.Session]: { proposed: 1, applied: 1 },
      [ActivationBackfillReminder.None]: { proposed: 2, applied: 2 },
    });

    const noTokenState = await activationStateRepo.findByUserId(noToken.userId);
    const bridge1State = await activationStateRepo.findByUserId(bridge1.userId);
    const bridge2AppliedState = await activationStateRepo.findByUserId(bridge2.userId);
    const sessionState = await activationStateRepo.findByUserId(session.userId);
    const activatedState = await activationStateRepo.findByUserId(activated.userId);
    const bridge1Baseline = new Date(
      BACKFILL_AT.getTime() + deterministicActivationJitterMs(bridge1.userId, JITTER_WINDOW_MS),
    );
    const bridge2Baseline = new Date(
      BACKFILL_AT.getTime() + deterministicActivationJitterMs(bridge2.userId, JITTER_WINDOW_MS),
    );
    const sessionBaseline = new Date(
      BACKFILL_AT.getTime() + deterministicActivationJitterMs(session.userId, JITTER_WINDOW_MS),
    );

    assert.equal(noTokenState?.bridgeSetupAt?.toISOString(), bridgeAt.toISOString());
    assert.equal(noTokenState?.bridgeReminderBaseAt, null);
    assert.equal(bridge1State?.mobileSetupAt?.toISOString(), mobileAt.toISOString());
    assert.equal(bridge1State?.bridgeReminderBaseAt?.toISOString(), bridge1Baseline.toISOString());
    assert.equal(bridge2AppliedState?.bridgeReminder1SentAt?.toISOString(), reminder1SentAt.toISOString());
    assert.equal(bridge2AppliedState?.bridgeReminderBaseAt?.toISOString(), bridge2Baseline.toISOString());
    assert.equal(sessionState?.bridgeSetupAt?.toISOString(), bridgeAt.toISOString());
    assert.equal(sessionState?.sessionReminderBaseAt?.toISOString(), sessionBaseline.toISOString());
    assert.equal(activatedState?.firstSessionAt?.toISOString(), preciseSessionAt.toISOString());
    assert.equal(activatedState?.bridgeReminderBaseAt, null);
    assert.equal(activatedState?.sessionReminderBaseAt, null);

    const rerun = await service.run({
      ...options,
      apply: true,
      backfillAt: new Date("2030-07-17T10:00:00.000Z"),
    });
    assert.equal(rerun.usersProposed, 0);
    assert.equal(rerun.usersApplied, 0);
    assert.equal(rerun.usersAlreadyBackfilled, 5);
    assert.equal(
      (await activationStateRepo.findByUserId(bridge1.userId))?.bridgeReminderBaseAt?.toISOString(),
      bridge1Baseline.toISOString(),
    );
  });

  it("uses a desktop-only token as app activation evidence", async () => {
    const user = await ctx.createUser();
    const appSetupAt = new Date("2026-06-01T08:00:00.000Z");
    await seedToken(user.userId, appSetupAt, DevicePlatform.windows);

    const report = await service.run({
      apply: true,
      backfillAt: BACKFILL_AT,
      batchLimit: 10,
      jitterWindowMs: 0,
    });
    const state = await activationStateRepo.findByUserId(user.userId);

    assert.equal(report.usersApplied, 1);
    assert.equal(report.byStage[ActivationBackfillStage.BridgeIncomplete].applied, 1);
    assert.equal(report.byReminder[ActivationBackfillReminder.Bridge1].applied, 1);
    assert.equal(state?.mobileSetupAt?.toISOString(), appSetupAt.toISOString());
    assert.equal(state?.bridgeReminderBaseAt?.toISOString(), BACKFILL_AT.toISOString());
  });

  it("produces stable bounded jitter", () => {
    const userId = new ObjectId().toHexString();
    const first = deterministicActivationJitterMs(userId, JITTER_WINDOW_MS);
    const second = deterministicActivationJitterMs(userId, JITTER_WINDOW_MS);

    assert.equal(first, second);
    assert.ok(first >= 0 && first < JITTER_WINDOW_MS);
    assert.equal(deterministicActivationJitterMs(userId, 0), 0);
    assert.throws(() => deterministicActivationJitterMs(userId, -1), RangeError);
  });

  it("preserves an organic baseline when the user no longer has a device token", async () => {
    const user = await ctx.createUser();
    const mobileAt = new Date("2026-06-01T10:00:00.000Z");
    await activationStateRepo.recordMilestones(user.userId, { mobileSetupAt: mobileAt }, mobileAt);

    const report = await service.run({
      apply: true,
      backfillAt: BACKFILL_AT,
      batchLimit: 10,
      jitterWindowMs: JITTER_WINDOW_MS,
    });
    const state = await activationStateRepo.findByUserId(user.userId);

    assert.equal(report.usersApplied, 1);
    assert.equal(report.byReminder[ActivationBackfillReminder.None].applied, 1);
    assert.equal(state?.backfilledAt?.toISOString(), BACKFILL_AT.toISOString());
    assert.equal(state?.bridgeReminderBaseAt?.toISOString(), mobileAt.toISOString());
  });

  it("continues after a per-user reconciliation failure and reports it", async (t) => {
    const failedUser = await ctx.createUser();
    const successfulUser = await ctx.createUser();
    const deviceTokenRepo = new DeviceTokenRepository(ctx.dbAccessor);
    t.mock.method(deviceTokenRepo, "findEarliestCreatedAt", async (userId: string) => {
      if (userId === failedUser.userId) {
        throw new Error("token lookup failed");
      }

      return null;
    });
    t.mock.method(console, "warn", () => {});
    const isolatedService = new ActivationBackfillService({
      userRepo: new UserRepository(ctx.dbAccessor),
      activationStateRepo,
      bridgeRepo: new BridgeRepository(ctx.dbAccessor),
      dailyUsageRepo: new DailyUsageRepository(ctx.dbAccessor),
      deviceTokenRepo,
    });

    const report = await isolatedService.run({
      apply: true,
      backfillAt: BACKFILL_AT,
      batchLimit: 1,
      jitterWindowMs: 0,
    });

    assert.equal(report.usersFailed, 1);
    assert.equal(report.usersApplied, 1);
    assert.equal(await activationStateRepo.findByUserId(failedUser.userId), null);
    assert.ok((await activationStateRepo.findByUserId(successfulUser.userId))?.backfilledAt);
  });
});

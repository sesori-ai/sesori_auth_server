import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { ObjectId } from "mongodb";
import { BridgePlatform } from "../../src/models/bridge.js";
import { DevicePlatform } from "../../src/models/device.js";
import type { Bridge, DailyUsage, DeviceToken } from "../../src/models/documents.js";
import { ActivationStateRepository } from "../../src/repositories/activation-state-repo.js";
import { BridgeRepository } from "../../src/repositories/bridge-repo.js";
import { DailyUsageRepository } from "../../src/repositories/daily-usage-repo.js";
import { DeviceTokenRepository } from "../../src/repositories/device-token-repo.js";
import { ActivationService } from "../../src/services/activation-service.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("ActivationService", () => {
  let ctx: TestContext;
  let activationStateRepo: ActivationStateRepository;
  let bridgeRepo: BridgeRepository;
  let dailyUsageRepo: DailyUsageRepository;
  let deviceTokenRepo: DeviceTokenRepository;
  let service: ActivationService;
  let logCalls: unknown[][];

  before(async () => {
    ctx = await createTestApp();
    activationStateRepo = new ActivationStateRepository(ctx.dbAccessor);
    bridgeRepo = new BridgeRepository(ctx.dbAccessor);
    dailyUsageRepo = new DailyUsageRepository(ctx.dbAccessor);
    deviceTokenRepo = new DeviceTokenRepository(ctx.dbAccessor);
    service = new ActivationService({ activationStateRepo, bridgeRepo, dailyUsageRepo, deviceTokenRepo });
  });

  after(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    logCalls = [];
    mock.method(console, "log", (...args: unknown[]) => {
      logCalls.push(args);
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("enrolls mobile setup and reconciles historical bridge and session milestones", async () => {
    const user = await ctx.createUser();
    const mobileAt = new Date("2026-07-10T08:00:00.000Z");
    const bridgeAt = new Date("2026-07-11T09:00:00.000Z");
    const sessionAt = new Date("2026-07-12T10:00:00.000Z");
    const observedAt = new Date("2026-07-15T10:00:00.000Z");
    await ctx.dbAccessor.getCollection<DeviceToken>(MongoDbDatabase.Auth, AuthDbCollection.DeviceTokens).insertOne({
      _id: new ObjectId(),
      userId: new ObjectId(user.userId),
      token: `activation-token-${user.userId}`,
      platform: DevicePlatform.ios,
      createdAt: mobileAt,
      updatedAt: mobileAt,
    });
    const bridge = await bridgeRepo.register({
      userId: user.userId,
      name: "Historical",
      platform: BridgePlatform.macos,
    });
    await ctx.dbAccessor
      .getCollection<Bridge>(MongoDbDatabase.Auth, AuthDbCollection.Bridges)
      .updateOne({ bridgeId: bridge.bridgeId }, { $set: { addedAt: bridgeAt, revokedAt: observedAt } });
    await ctx.dbAccessor.getCollection<DailyUsage>(MongoDbDatabase.Auth, AuthDbCollection.DailyUsage).insertOne({
      _id: new ObjectId(),
      userId: new ObjectId(user.userId),
      date: "2026-07-12",
      transcriptionSeconds: 0,
      metadataRequestCount: 1,
      createdAt: sessionAt,
      updatedAt: sessionAt,
    });

    const state = await service.recordAppSetup(user.userId, observedAt);

    assert.equal(state.mobileSetupAt?.toISOString(), mobileAt.toISOString());
    assert.equal(state.bridgeSetupAt?.toISOString(), bridgeAt.toISOString());
    assert.equal(state.firstSessionAt?.toISOString(), sessionAt.toISOString());
    assert.equal(state.bridgeReminderBaseAt?.toISOString(), mobileAt.toISOString());
    assert.equal(state.sessionReminderBaseAt?.toISOString(), bridgeAt.toISOString());
    assert.deepEqual(
      logCalls.map((args) => (args[1] as { milestone: string }).milestone),
      ["mobile_setup", "bridge_setup", "first_session"],
    );
  });

  it("records app setup for a device-token registration", async () => {
    const user = await ctx.createUser();
    const observedAt = new Date("2026-07-12T10:00:00.000Z");

    const state = await service.recordAppSetup(user.userId, observedAt);

    assert.equal(state.mobileSetupAt?.toISOString(), observedAt.toISOString());
    assert.equal(state.bridgeReminderBaseAt?.toISOString(), observedAt.toISOString());
    assert.deepEqual(
      logCalls.map((args) => (args[1] as { milestone: string }).milestone),
      ["mobile_setup"],
    );
  });

  it("records bridge and session milestones before mobile setup without creating reminder baselines", async () => {
    const user = await ctx.createUser();
    const bridgeAt = new Date("2026-07-12T10:00:00.000Z");
    const sessionAt = new Date("2026-07-12T11:00:00.000Z");

    await service.recordBridgeSetup(user.userId, bridgeAt);
    const state = await service.recordFirstSession(user.userId, sessionAt);

    assert.equal(state.mobileSetupAt, null);
    assert.equal(state.bridgeSetupAt?.toISOString(), bridgeAt.toISOString());
    assert.equal(state.firstSessionAt?.toISOString(), sessionAt.toISOString());
    assert.equal(state.bridgeReminderBaseAt, null);
    assert.equal(state.sessionReminderBaseAt, null);
  });

  it("logs a first milestone once when concurrent hooks race", async () => {
    const user = await ctx.createUser();
    const bridgeAt = new Date("2026-07-12T10:00:00.000Z");

    await Promise.all([
      service.recordBridgeSetup(user.userId, bridgeAt),
      service.recordBridgeSetup(user.userId, bridgeAt),
    ]);

    assert.equal(logCalls.filter((args) => (args[1] as { milestone: string }).milestone === "bridge_setup").length, 1);
  });

  it("uses the earliest historical bridge when recording a later registration", async () => {
    const user = await ctx.createUser();
    const historicalAt = new Date("2026-07-10T10:00:00.000Z");
    const observedAt = new Date("2026-07-15T10:00:00.000Z");
    const historical = await bridgeRepo.register({
      userId: user.userId,
      name: "Historical",
      platform: BridgePlatform.macos,
    });
    const collection = ctx.dbAccessor.getCollection<Bridge>(MongoDbDatabase.Auth, AuthDbCollection.Bridges);
    await collection.updateOne(
      { bridgeId: historical.bridgeId },
      { $set: { addedAt: historicalAt, revokedAt: observedAt } },
    );
    await bridgeRepo.register({ userId: user.userId, name: "Current", platform: BridgePlatform.linux });

    const state = await service.recordBridgeSetup(user.userId, observedAt);

    assert.equal(state.bridgeSetupAt?.toISOString(), historicalAt.toISOString());
  });

  it("repairs mobile setup from token history when recording bridge setup", async () => {
    const user = await ctx.createUser();
    await deviceTokenRepo.upsertToken(user.userId, `bridge-repair-token-${user.userId}`, DevicePlatform.ios);
    const mobileAt = await deviceTokenRepo.findEarliestCreatedAt(user.userId);
    const bridge = await bridgeRepo.register({
      userId: user.userId,
      name: "Repair",
      platform: BridgePlatform.macos,
    });

    const state = await service.recordBridgeSetup(user.userId, bridge.addedAt);

    assert.equal(state.mobileSetupAt?.toISOString(), mobileAt?.toISOString());
    assert.equal(state.bridgeSetupAt?.toISOString(), bridge.addedAt.toISOString());
    assert.equal(state.bridgeReminderBaseAt?.toISOString(), mobileAt?.toISOString());
    assert.equal(state.sessionReminderBaseAt?.toISOString(), bridge.addedAt.toISOString());
  });

  it("reconciles app setup from a persisted desktop token", async () => {
    const user = await ctx.createUser();
    await deviceTokenRepo.upsertToken(user.userId, `desktop-only-token-${user.userId}`, DevicePlatform.windows);
    const appSetupAt = await deviceTokenRepo.findEarliestCreatedAt(user.userId);
    const bridge = await bridgeRepo.register({
      userId: user.userId,
      name: "Desktop only",
      platform: BridgePlatform.windows,
    });

    const state = await service.recordBridgeSetup(user.userId, bridge.addedAt);

    assert.equal(state.mobileSetupAt?.toISOString(), appSetupAt?.toISOString());
    assert.equal(state.bridgeSetupAt?.toISOString(), bridge.addedAt.toISOString());
    assert.equal(state.bridgeReminderBaseAt?.toISOString(), appSetupAt?.toISOString());
    assert.equal(state.sessionReminderBaseAt?.toISOString(), bridge.addedAt.toISOString());
  });

  it("uses historical metadata evidence when recording a later session request", async () => {
    const user = await ctx.createUser();
    const historicalAt = new Date("2026-07-10T10:00:00.000Z");
    const observedAt = new Date("2026-07-15T10:00:00.000Z");
    await ctx.dbAccessor.getCollection<DailyUsage>(MongoDbDatabase.Auth, AuthDbCollection.DailyUsage).insertOne({
      _id: new ObjectId(),
      userId: new ObjectId(user.userId),
      date: "2026-07-10",
      transcriptionSeconds: 0,
      metadataRequestCount: 1,
      createdAt: historicalAt,
      updatedAt: historicalAt,
    });

    const state = await service.recordFirstSession(user.userId, observedAt);

    assert.equal(state.firstSessionAt?.toISOString(), historicalAt.toISOString());
  });

  it("repairs bridge setup from bridge history when recording a session", async () => {
    const user = await ctx.createUser();
    const mobileAt = new Date("2026-07-10T10:00:00.000Z");
    const sessionAt = new Date("2026-07-12T10:00:00.000Z");
    await activationStateRepo.recordMilestones(user.userId, { mobileSetupAt: mobileAt }, mobileAt);
    const bridge = await bridgeRepo.register({ userId: user.userId, name: "Repair", platform: BridgePlatform.linux });

    const state = await service.recordFirstSession(user.userId, sessionAt);

    assert.equal(state.bridgeSetupAt?.toISOString(), bridge.addedAt.toISOString());
    assert.equal(state.firstSessionAt?.toISOString(), sessionAt.toISOString());
    assert.equal(state.sessionReminderBaseAt?.toISOString(), bridge.addedAt.toISOString());
  });

  it("preserves an earlier observed session time when its initial read loses a race", async () => {
    const user = await ctx.createUser();
    const earlierAt = new Date("2026-07-12T10:00:00.000Z");
    const laterAt = new Date("2026-07-12T10:00:01.000Z");
    await activationStateRepo.recordMilestones(user.userId, { firstSessionAt: laterAt }, laterAt);

    const state = await service.recordFirstSession(user.userId, earlierAt);

    assert.equal(state.firstSessionAt?.toISOString(), earlierAt.toISOString());
  });

  it("retries unresolved historical reconciliation on later token registration", async () => {
    const user = await ctx.createUser();
    const mobileAt = new Date("2026-07-10T08:00:00.000Z");
    const bridgeAt = new Date("2026-07-11T09:00:00.000Z");
    const sessionAt = new Date("2026-07-12T10:00:00.000Z");
    const collection = ctx.dbAccessor.getCollection<DeviceToken>(MongoDbDatabase.Auth, AuthDbCollection.DeviceTokens);
    await collection.insertOne({
      _id: new ObjectId(),
      userId: new ObjectId(user.userId),
      token: `retry-token-${user.userId}`,
      platform: DevicePlatform.ios,
      createdAt: mobileAt,
      updatedAt: mobileAt,
    });
    await service.recordAppSetup(user.userId, mobileAt);

    const bridge = await bridgeRepo.register({ userId: user.userId, name: "Later", platform: BridgePlatform.macos });
    await ctx.dbAccessor
      .getCollection<Bridge>(MongoDbDatabase.Auth, AuthDbCollection.Bridges)
      .updateOne({ bridgeId: bridge.bridgeId }, { $set: { addedAt: bridgeAt } });
    await ctx.dbAccessor.getCollection<DailyUsage>(MongoDbDatabase.Auth, AuthDbCollection.DailyUsage).insertOne({
      _id: new ObjectId(),
      userId: new ObjectId(user.userId),
      date: "2026-07-12",
      transcriptionSeconds: 0,
      metadataRequestCount: 1,
      createdAt: sessionAt,
      updatedAt: sessionAt,
    });

    const state = await service.recordAppSetup(user.userId, new Date("2026-07-15T10:00:00.000Z"));

    assert.equal(state.mobileSetupAt?.toISOString(), mobileAt.toISOString());
    assert.equal(state.bridgeSetupAt?.toISOString(), bridgeAt.toISOString());
    assert.equal(state.firstSessionAt?.toISOString(), sessionAt.toISOString());
    assert.equal(state.sessionReminderBaseAt?.toISOString(), bridgeAt.toISOString());
  });

  it("falls back to the observed registration time when no token history is available", async () => {
    const user = await ctx.createUser();
    const observedAt = new Date("2026-07-12T10:00:00.000Z");

    const state = await service.recordAppSetup(user.userId, observedAt);

    assert.equal(state.mobileSetupAt?.toISOString(), observedAt.toISOString());
    assert.equal(state.bridgeReminderBaseAt?.toISOString(), observedAt.toISOString());
  });
});

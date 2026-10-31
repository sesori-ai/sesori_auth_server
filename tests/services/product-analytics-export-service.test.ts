import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InternalServerError } from "../../src/lib/errors.js";
import { productAnalyticsUserKeyFor } from "../../src/lib/product-analytics-user-key.js";
import type {
  ProductAnalyticsActivationMilestones,
  ProductAnalyticsDesktopEvent,
  ProductAnalyticsExportRow,
  ProductAnalyticsExportUser,
  ProductAnalyticsPreferenceChange,
  ProductAnalyticsSetupCohortRow,
} from "../../src/models/product-analytics-export.js";
import type { ProductAnalyticsExportRun } from "../../src/repositories/product-analytics-export-repo.js";
import { ProductAnalyticsExportService } from "../../src/services/product-analytics-export-service.js";
import {
  ProductAnalyticsEventName,
  ProductAnalyticsEventPlatform,
  ProductAnalyticsPreference,
} from "../../src/types/product-analytics.js";

const run: ProductAnalyticsExportRun = {
  runId: "testrun01",
  milestoneStagingTableId: "auth_user_milestones_staging_testrun01",
  cohortStagingTableId: "auth_weekly_setup_cohorts_staging_testrun01",
  desktopEventStagingTableId: "desktop_product_events_staging_testrun01",
};
const pseudonymizationKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function userKeyFor(input: { userId: string }): string {
  return productAnalyticsUserKeyFor({
    userId: input.userId,
    pseudonymizationKey,
  });
}

function nextClockValue(input: { values: Date[] }): Date {
  const value = input.values.shift();
  assert.ok(value, "The test read the clock more times than it scripted");
  return value;
}

function weekFor(date: Date): string {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  copy.setUTCDate(copy.getUTCDate() - ((copy.getUTCDay() + 6) % 7));
  return copy.toISOString().slice(0, 10);
}

class FakeUserRepository {
  constructor(
    readonly users: ProductAnalyticsExportUser[],
    readonly changes: ProductAnalyticsPreferenceChange[],
  ) {}

  async findProductAnalyticsExportBatch(input: {
    afterUserId: string | null;
    batchLimit: number;
    createdAtOrBefore: Date;
  }): Promise<ProductAnalyticsExportUser[]> {
    return this.users
      .filter(
        (user) =>
          user.accountCreatedAt <= input.createdAtOrBefore &&
          (input.afterUserId === null || user.userId > input.afterUserId),
      )
      .slice(0, input.batchLimit);
  }

  async findProductAnalyticsPreferenceChangeBatch(input: {
    afterUserId: string | null;
    batchLimit: number;
    changedAfter: Date;
  }): Promise<ProductAnalyticsPreferenceChange[]> {
    return this.changes
      .filter(
        (change) =>
          change.changedAt > input.changedAfter && (input.afterUserId === null || change.userId > input.afterUserId),
      )
      .slice(0, input.batchLimit);
  }
}

class FakeActivationStateRepository {
  lastRunCutoff: Date | null = null;

  constructor(readonly milestones: Map<string, ProductAnalyticsActivationMilestones>) {}

  async findProductAnalyticsMilestonesByUserIds(input: {
    userIds: string[];
    runCutoff: Date;
  }): Promise<Map<string, ProductAnalyticsActivationMilestones>> {
    this.lastRunCutoff = input.runCutoff;
    return new Map(
      input.userIds.flatMap((userId) => (this.milestones.has(userId) ? [[userId, this.milestones.get(userId)!]] : [])),
    );
  }
}

class FakeEventRepository {
  readonly inputs: Array<{ start: Date; end: Date; batchLimit: number }> = [];

  constructor(
    readonly batches: ProductAnalyticsDesktopEvent[][] = [],
    readonly onScan: () => void = () => {},
  ) {}

  async *findExportBatches(input: { start: Date; end: Date; batchLimit: number }) {
    this.inputs.push(input);
    this.onScan();
    yield* this.batches;
  }
}

class FakeExportRepository {
  readonly milestones: ProductAnalyticsExportRow[] = [];
  readonly desktopEvents: ProductAnalyticsDesktopEvent[] = [];
  cohorts: ProductAnalyticsSetupCohortRow[] = [];
  validationInput: {
    expectedMilestoneRows: number;
    expectedTotalAccounts: number;
    expectedEnabledAccounts: number;
    expectedDesktopEventRows: number;
    desktopEventWindow: { start: Date; end: Date };
    metadata: unknown;
  } | null = null;
  cleanupCalls = 0;
  failAppend = false;
  beginRunInput: { runId: string; runCutoff: Date; expiresAt: Date } | null = null;
  readonly appendRuns: ProductAnalyticsExportRun[] = [];

  async beginRun(input: { runId: string; runCutoff: Date; expiresAt: Date }): Promise<ProductAnalyticsExportRun> {
    this.beginRunInput = input;
    return run;
  }

  async appendMilestones(input: { run: ProductAnalyticsExportRun; rows: ProductAnalyticsExportRow[] }): Promise<void> {
    this.appendRuns.push(input.run);
    if (this.failAppend) {
      throw new Error("staging failed");
    }
    this.milestones.push(...input.rows);
  }

  async appendDesktopEvents(input: { events: ProductAnalyticsDesktopEvent[] }): Promise<void> {
    this.desktopEvents.push(...input.events);
  }

  async writeCohorts(input: { rows: ProductAnalyticsSetupCohortRow[] }): Promise<void> {
    this.cohorts = input.rows;
  }

  async removeUserKeys(input: { userKeys: string[] }): Promise<Map<string, number>> {
    const removed = new Map<string, number>();
    for (let index = this.milestones.length - 1; index >= 0; index -= 1) {
      const row = this.milestones[index];
      if (input.userKeys.includes(row.userKey)) {
        const week = weekFor(row.accountCreatedAt);
        removed.set(week, (removed.get(week) ?? 0) + 1);
        this.milestones.splice(index, 1);
      }
    }
    return removed;
  }

  async validateAndPromote(input: {
    expectedMilestoneRows: number;
    expectedTotalAccounts: number;
    expectedEnabledAccounts: number;
    expectedDesktopEventRows: number;
    desktopEventWindow: { start: Date; end: Date };
    metadata: unknown;
  }): Promise<void> {
    this.validationInput = input;
  }

  async cleanup(): Promise<void> {
    this.cleanupCalls += 1;
  }
}

describe("ProductAnalyticsExportService", () => {
  it("pins the lowercase canonical account-key HMAC", () => {
    assert.equal(
      userKeyFor({ userId: "000000000000000000000001" }),
      "1e02442b1a7fe039fd2900710cf727d72adc7d3379c8e1b41ac5bdb32924f4e5",
    );
    assert.equal(
      userKeyFor({ userId: "abcdefabcdefabcdefabcdef" }),
      userKeyFor({ userId: "ABCDEFABCDEFABCDEFABCDEF" }),
    );
    assert.notEqual(
      userKeyFor({ userId: "000000000000000000000001" }),
      productAnalyticsUserKeyFor({
        userId: "000000000000000000000001",
        pseudonymizationKey: Buffer.alloc(32, 1),
      }),
    );
  });

  it("filters before aggregation, reconciles late preference changes, and promotes both products", async () => {
    const runCutoff = new Date("2026-07-28T12:00:00.000Z");
    const startedAt = new Date("2026-07-28T12:01:00.000Z");
    const preferenceScanCutoff = new Date("2026-07-28T12:02:00.000Z");
    const ids = Array.from({ length: 6 }, (_, index) => `00000000000000000000000${index + 1}`);
    const createdThisWeek = new Date("2026-07-20T12:00:00.000Z");
    const createdLastWeek = new Date("2026-07-13T12:00:00.000Z");
    const users: ProductAnalyticsExportUser[] = [
      {
        userId: ids[0],
        accountCreatedAt: createdThisWeek,
        preference: ProductAnalyticsPreference.Enabled,
        preferenceUpdatedAt: createdThisWeek,
        exportSuppressedAt: null,
      },
      {
        userId: ids[1],
        accountCreatedAt: createdThisWeek,
        preference: ProductAnalyticsPreference.Disabled,
        preferenceUpdatedAt: createdThisWeek,
        exportSuppressedAt: null,
      },
      {
        userId: ids[2],
        accountCreatedAt: createdThisWeek,
        preference: ProductAnalyticsPreference.Enabled,
        preferenceUpdatedAt: createdThisWeek,
        exportSuppressedAt: null,
      },
      {
        userId: ids[3],
        accountCreatedAt: createdThisWeek,
        preference: ProductAnalyticsPreference.Disabled,
        preferenceUpdatedAt: createdThisWeek,
        exportSuppressedAt: new Date("2026-07-25T12:00:00.000Z"),
      },
      {
        userId: ids[4],
        accountCreatedAt: createdThisWeek,
        preference: ProductAnalyticsPreference.Enabled,
        preferenceUpdatedAt: new Date("2026-07-28T12:00:01.000Z"),
        exportSuppressedAt: null,
      },
      {
        userId: ids[5],
        accountCreatedAt: createdLastWeek,
        preference: ProductAnalyticsPreference.Enabled,
        preferenceUpdatedAt: createdLastWeek,
        exportSuppressedAt: null,
      },
    ];
    const userRepo = new FakeUserRepository(users, [
      {
        userId: ids[5],
        changedAt: new Date("2026-07-28T12:01:30.000Z"),
        exportSuppressedAt: null,
      },
    ]);
    const activationRepo = new FakeActivationStateRepository(
      new Map([
        [
          ids[0],
          {
            notificationRegisteredAt: new Date("2026-07-21T12:00:00.000Z"),
            bridgeRegisteredAt: new Date("2026-07-28T12:00:00.000Z"),
            legacyFirstMetadataRequestAt: null,
          },
        ],
      ]),
    );
    const exportRepo = new FakeExportRepository();
    const finalControlLoadedAt = new Date("2026-07-28T12:03:00.000Z");
    const controlLoadTimes: Date[] = [];
    const clockValues = [startedAt, preferenceScanCutoff, finalControlLoadedAt];
    const service = new ProductAnalyticsExportService({
      userRepo,
      activationStateRepo: activationRepo,
      controlRepo: {
        async loadActiveInternalUserKeys(input) {
          controlLoadTimes.push(input.loadedAt);
          return {
            userKeys: new Set([userKeyFor({ userId: ids[2] })]),
            controlUpdatedAt: new Date("2026-07-28T00:00:00.000Z"),
          };
        },
      },
      exportRepo,
      eventRepo: new FakeEventRepository(),
      batchLimit: 2,
      pseudonymizationKey,
      clock: () => nextClockValue({ values: clockValues }),
      createRunId: () => "testrun01",
    });

    const report = await service.run({ runCutoff });

    assert.equal(report.usersScanned, 6);
    assert.equal(report.sourceSuppressedUsers, 1);
    assert.equal(report.internalUsers, 1);
    assert.equal(report.externalAccounts, 4);
    assert.equal(report.enabledAccounts, 1);
    assert.equal(report.optedOutAccounts, 1);
    assert.equal(report.preferenceAfterCutoffAccounts, 1);
    assert.equal(report.latePreferenceRowsRemoved, 1);
    assert.equal(report.milestoneRowsStaged, 1);
    assert.equal(report.cohortRows, 2);
    assert.equal(exportRepo.cleanupCalls, 1);
    assert.equal(exportRepo.validationInput?.expectedMilestoneRows, 1);
    assert.equal(exportRepo.validationInput?.expectedTotalAccounts, 4);
    assert.equal(exportRepo.validationInput?.expectedEnabledAccounts, 1);
    assert.deepEqual(controlLoadTimes, [startedAt, finalControlLoadedAt]);
    assert.equal(activationRepo.lastRunCutoff?.toISOString(), runCutoff.toISOString());
    assert.equal(exportRepo.beginRunInput?.runCutoff.toISOString(), runCutoff.toISOString());
    assert.equal(
      exportRepo.beginRunInput?.expiresAt.toISOString(),
      new Date(startedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    );
    assert.equal(
      exportRepo.appendRuns.every((value) => value.milestoneStagingTableId === run.milestoneStagingTableId),
      true,
    );
    assert.deepEqual(exportRepo.validationInput?.metadata, {
      runId: "testrun01",
      runCutoff,
      preferenceScanCutoff,
      controlUpdatedAt: new Date("2026-07-28T00:00:00.000Z"),
      usersScanned: 6,
      sourceSuppressedUsers: 1,
      internalUsers: 1,
      externalAccounts: 4,
      enabledAccounts: 1,
      optedOutAccounts: 1,
      preferenceAfterCutoffAccounts: 1,
      latePreferenceRowsRemoved: 1,
      milestoneRowsPublished: 1,
      cohortRowsPublished: 2,
      preCreationMilestonesDropped: 0,
    });
    assert.equal(exportRepo.milestones.length, 1);
    assert.equal(exportRepo.milestones[0].userKey, userKeyFor({ userId: ids[0] }));
    assert.equal(Object.hasOwn(exportRepo.milestones[0], "userId"), false);
    assert.deepEqual(
      exportRepo.cohorts.map((cohort) => ({
        week: cohort.cohortWeek,
        total: cohort.totalAccounts,
        enabled: cohort.enabledAccounts,
        notification1: cohort.notificationRegisteredWithin1Day,
        bridge7: cohort.bridgeRegisteredWithin7Days,
        bridge30: cohort.bridgeRegisteredWithin30Days,
      })),
      [
        { week: "2026-07-13", total: 1, enabled: 0, notification1: 0, bridge7: 0, bridge30: 0 },
        { week: "2026-07-20", total: 3, enabled: 1, notification1: 1, bridge7: 0, bridge30: 1 },
      ],
    );
  });

  it("leaves publication untouched and still cleans staging after a failed page", async () => {
    const exportRepo = new FakeExportRepository();
    exportRepo.failAppend = true;
    const user: ProductAnalyticsExportUser = {
      userId: "000000000000000000000001",
      accountCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
      preference: ProductAnalyticsPreference.Enabled,
      preferenceUpdatedAt: new Date("2026-07-20T12:00:00.000Z"),
      exportSuppressedAt: null,
    };
    const service = new ProductAnalyticsExportService({
      userRepo: new FakeUserRepository([user], []),
      activationStateRepo: new FakeActivationStateRepository(new Map()),
      controlRepo: {
        async loadActiveInternalUserKeys() {
          return { userKeys: new Set<string>(), controlUpdatedAt: new Date("2026-07-28T00:00:00.000Z") };
        },
      },
      exportRepo,
      eventRepo: new FakeEventRepository(),
      batchLimit: 2,
      pseudonymizationKey,
      clock: () => new Date("2026-07-28T12:01:00.000Z"),
      createRunId: () => "testrun01",
    });

    await assert.rejects(() => service.run({ runCutoff: new Date("2026-07-28T12:00:00.000Z") }), /staging failed/);
    assert.equal(exportRepo.validationInput, null);
    assert.equal(exportRepo.cleanupCalls, 1);
  });

  it("aborts publication when source suppression lands during the run", async () => {
    const runCutoff = new Date("2026-07-28T12:00:00.000Z");
    const user: ProductAnalyticsExportUser = {
      userId: "000000000000000000000001",
      accountCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
      preference: ProductAnalyticsPreference.Enabled,
      preferenceUpdatedAt: new Date("2026-07-20T12:00:00.000Z"),
      exportSuppressedAt: null,
    };
    const exportRepo = new FakeExportRepository();
    const service = new ProductAnalyticsExportService({
      userRepo: new FakeUserRepository(
        [user],
        [
          {
            userId: user.userId,
            changedAt: new Date("2026-07-28T12:01:30.000Z"),
            exportSuppressedAt: new Date("2026-07-28T12:01:30.000Z"),
          },
        ],
      ),
      activationStateRepo: new FakeActivationStateRepository(new Map()),
      controlRepo: {
        async loadActiveInternalUserKeys() {
          return { userKeys: new Set<string>(), controlUpdatedAt: new Date("2026-07-28T00:00:00.000Z") };
        },
      },
      exportRepo,
      eventRepo: new FakeEventRepository(),
      batchLimit: 2,
      pseudonymizationKey,
      clock: (() => {
        const values = [new Date("2026-07-28T12:01:00.000Z"), new Date("2026-07-28T12:02:00.000Z")];
        return () => nextClockValue({ values });
      })(),
      createRunId: () => "testrun01",
    });

    await assert.rejects(
      () => service.run({ runCutoff }),
      (error: unknown) =>
        error instanceof Error && error.message === "internal_server_error" && exportRepo.validationInput === null,
    );
    assert.equal(exportRepo.cleanupCalls, 1);
  });

  it("aborts and cleans staging when the internal-exclusion control changes", async () => {
    const runCutoff = new Date("2026-07-28T12:00:00.000Z");
    const user: ProductAnalyticsExportUser = {
      userId: "000000000000000000000001",
      accountCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
      preference: ProductAnalyticsPreference.Enabled,
      preferenceUpdatedAt: new Date("2026-07-20T12:00:00.000Z"),
      exportSuppressedAt: null,
    };
    const exportRepo = new FakeExportRepository();
    let controlLoads = 0;
    const service = new ProductAnalyticsExportService({
      userRepo: new FakeUserRepository([user], []),
      activationStateRepo: new FakeActivationStateRepository(new Map()),
      controlRepo: {
        async loadActiveInternalUserKeys() {
          controlLoads += 1;
          return {
            userKeys: new Set<string>(),
            controlUpdatedAt: new Date(controlLoads === 1 ? "2026-07-28T00:00:00.000Z" : "2026-07-28T00:01:00.000Z"),
          };
        },
      },
      exportRepo,
      eventRepo: new FakeEventRepository(),
      batchLimit: 2,
      pseudonymizationKey,
      clock: (() => {
        const values = [
          new Date("2026-07-28T12:01:00.000Z"),
          new Date("2026-07-28T12:02:00.000Z"),
          new Date("2026-07-28T12:03:00.000Z"),
        ];
        return () => nextClockValue({ values });
      })(),
      createRunId: () => "testrun01",
    });

    await assert.rejects(
      () => service.run({ runCutoff }),
      (error: unknown) =>
        error instanceof InternalServerError &&
        error.debugMessage === "Product analytics internal exclusions changed during export" &&
        exportRepo.validationInput === null,
    );
    assert.equal(exportRepo.cleanupCalls, 1);
  });

  it("publishes a valid empty snapshot when every account is excluded", async () => {
    const runCutoff = new Date("2026-07-28T12:00:00.000Z");
    const suppressedUser: ProductAnalyticsExportUser = {
      userId: "000000000000000000000001",
      accountCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
      preference: ProductAnalyticsPreference.Disabled,
      preferenceUpdatedAt: new Date("2026-07-20T12:00:00.000Z"),
      exportSuppressedAt: new Date("2026-07-21T12:00:00.000Z"),
    };
    const internalUser: ProductAnalyticsExportUser = {
      userId: "000000000000000000000002",
      accountCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
      preference: ProductAnalyticsPreference.Enabled,
      preferenceUpdatedAt: new Date("2026-07-20T12:00:00.000Z"),
      exportSuppressedAt: null,
    };
    const exportRepo = new FakeExportRepository();
    const control = {
      userKeys: new Set([userKeyFor({ userId: internalUser.userId })]),
      controlUpdatedAt: new Date("2026-07-28T00:00:00.000Z"),
    };
    const service = new ProductAnalyticsExportService({
      userRepo: new FakeUserRepository([suppressedUser, internalUser], []),
      activationStateRepo: new FakeActivationStateRepository(new Map()),
      controlRepo: {
        async loadActiveInternalUserKeys() {
          return control;
        },
      },
      exportRepo,
      eventRepo: new FakeEventRepository(),
      batchLimit: 2,
      pseudonymizationKey,
      clock: (() => {
        const values = [
          new Date("2026-07-28T12:01:00.000Z"),
          new Date("2026-07-28T12:02:00.000Z"),
          new Date("2026-07-28T12:03:00.000Z"),
        ];
        return () => nextClockValue({ values });
      })(),
      createRunId: () => "testrun01",
    });

    const report = await service.run({ runCutoff });

    assert.equal(report.externalAccounts, 0);
    assert.equal(report.enabledAccounts, 0);
    assert.equal(report.cohortRows, 0);
    assert.equal(exportRepo.validationInput?.expectedMilestoneRows, 0);
    assert.equal(exportRepo.validationInput?.expectedTotalAccounts, 0);
    assert.equal(exportRepo.validationInput?.expectedEnabledAccounts, 0);
    assert.equal(exportRepo.cleanupCalls, 1);
  });

  it("drops and counts milestone timestamps predating account creation", async () => {
    const runCutoff = new Date("2026-07-28T12:00:00.000Z");
    const accountCreatedAt = new Date("2026-07-20T12:00:00.000Z");
    const user: ProductAnalyticsExportUser = {
      userId: "000000000000000000000001",
      accountCreatedAt,
      preference: ProductAnalyticsPreference.Enabled,
      preferenceUpdatedAt: accountCreatedAt,
      exportSuppressedAt: null,
    };
    const preCreation = new Date("2026-07-10T12:00:00.000Z");
    const validBridgeAt = new Date("2026-07-21T12:00:00.000Z");
    const exportRepo = new FakeExportRepository();
    const service = new ProductAnalyticsExportService({
      userRepo: new FakeUserRepository([user], []),
      activationStateRepo: new FakeActivationStateRepository(
        new Map([
          [
            user.userId,
            {
              notificationRegisteredAt: preCreation,
              bridgeRegisteredAt: validBridgeAt,
              legacyFirstMetadataRequestAt: preCreation,
            },
          ],
        ]),
      ),
      controlRepo: {
        async loadActiveInternalUserKeys() {
          return { userKeys: new Set<string>(), controlUpdatedAt: new Date("2026-07-28T00:00:00.000Z") };
        },
      },
      exportRepo,
      eventRepo: new FakeEventRepository(),
      batchLimit: 2,
      pseudonymizationKey,
      clock: (() => {
        const values = [
          new Date("2026-07-28T12:01:00.000Z"),
          new Date("2026-07-28T12:02:00.000Z"),
          new Date("2026-07-28T12:03:00.000Z"),
        ];
        return () => nextClockValue({ values });
      })(),
      createRunId: () => "testrun01",
    });

    const report = await service.run({ runCutoff });

    assert.equal(report.preCreationMilestonesDropped, 2);
    assert.equal(report.milestoneRowsStaged, 1);
    assert.equal(exportRepo.milestones.length, 1);
    assert.equal(exportRepo.milestones[0].notificationRegisteredAt, null);
    assert.equal(exportRepo.milestones[0].legacyFirstMetadataRequestAt, null);
    assert.equal(exportRepo.milestones[0].bridgeRegisteredAt?.toISOString(), validBridgeAt.toISOString());
    // The dropped milestone must not count toward within-N-day cohort columns.
    assert.equal(exportRepo.cohorts.length, 1);
    assert.equal(exportRepo.cohorts[0].notificationRegisteredWithin30Days, 0);
    assert.equal(exportRepo.cohorts[0].bridgeRegisteredWithin7Days, 1);
  });

  describe("desktop events", () => {
    const desktopEvent: ProductAnalyticsDesktopEvent = {
      userKey: "c".repeat(64),
      eventName: ProductAnalyticsEventName.SessionAbortSucceeded,
      occurredAtMicros: 1_785_000_000_000_000,
      receivedAt: new Date("2026-07-27T12:00:00.000Z"),
      schemaVersion: 1,
      platform: ProductAnalyticsEventPlatform.Linux,
      appVersion: "1.2.3",
      params: {},
    };
    const emptyControl = {
      async loadActiveInternalUserKeys() {
        return { userKeys: new Set<string>(), controlUpdatedAt: new Date("2026-07-01T00:00:00.000Z") };
      },
    };

    function serviceWith(input: {
      eventRepo: FakeEventRepository;
      exportRepo: FakeExportRepository;
      userRepo?: FakeUserRepository;
      now: Date;
    }) {
      return new ProductAnalyticsExportService({
        userRepo: input.userRepo ?? new FakeUserRepository([], []),
        activationStateRepo: new FakeActivationStateRepository(new Map()),
        controlRepo: emptyControl,
        exportRepo: input.exportRepo,
        eventRepo: input.eventRepo,
        batchLimit: 2,
        pseudonymizationKey,
        clock: () => input.now,
        createRunId: () => "testrun01",
      });
    }

    for (const [description, runCutoff, start, end] of [
      ["the daily run", "2026-07-28T03:00:00.000Z", "2026-07-21", "2026-07-28"],
      ["a midday manual run", "2026-07-28T12:34:56.789Z", "2026-07-21", "2026-07-28"],
      ["a run exactly at 00:00 UTC", "2026-07-28T00:00:00.000Z", "2026-07-21", "2026-07-28"],
      ["a run just before 00:00 UTC", "2026-07-27T23:59:59.999Z", "2026-07-20", "2026-07-27"],
      ["a run across a month boundary", "2026-08-03T03:00:00.000Z", "2026-07-27", "2026-08-03"],
    ] as const) {
      it(`loads the 7 closed UTC days before ${description}`, async () => {
        const eventRepo = new FakeEventRepository([[desktopEvent, desktopEvent], [desktopEvent]]);
        const exportRepo = new FakeExportRepository();

        await serviceWith({ eventRepo, exportRepo, now: new Date(runCutoff) }).run({ runCutoff: new Date(runCutoff) });

        const window = { start: new Date(`${start}T00:00:00.000Z`), end: new Date(`${end}T00:00:00.000Z`) };
        assert.deepEqual(eventRepo.inputs, [{ ...window, batchLimit: 2 }]);
        assert.deepEqual(exportRepo.validationInput?.desktopEventWindow, window);
        assert.equal(exportRepo.desktopEvents.length, 3);
        assert.equal(exportRepo.validationInput?.expectedDesktopEventRows, 3);
        assert.equal(exportRepo.cleanupCalls, 1);
      });
    }

    it("publishes an empty desktop load", async () => {
      const runCutoff = new Date("2026-07-28T03:00:00.000Z");
      const exportRepo = new FakeExportRepository();

      await serviceWith({ eventRepo: new FakeEventRepository(), exportRepo, now: runCutoff }).run({ runCutoff });

      assert.equal(exportRepo.validationInput?.expectedDesktopEventRows, 0);
    });

    it("aborts with staging cleaned up when a suppression lands during the desktop scan", async () => {
      const runCutoff = new Date("2026-07-28T03:00:00.000Z");
      const exportRepo = new FakeExportRepository();
      const userRepo = new FakeUserRepository([], []);
      const suppressedAt = new Date("2026-07-28T03:00:30.000Z");
      const eventRepo = new FakeEventRepository([[desktopEvent]], () => {
        userRepo.changes.push({
          userId: "000000000000000000000001",
          changedAt: suppressedAt,
          exportSuppressedAt: suppressedAt,
        });
      });

      await assert.rejects(
        () => serviceWith({ eventRepo, exportRepo, userRepo, now: suppressedAt }).run({ runCutoff }),
        (error: unknown) =>
          error instanceof InternalServerError &&
          error.debugMessage === "Product analytics source suppression changed during export",
      );

      assert.equal(exportRepo.desktopEvents.length, 1);
      assert.equal(exportRepo.validationInput, null);
      assert.equal(exportRepo.cleanupCalls, 1);
    });

    it("fails the whole run with staging cleaned up when the desktop scan fails", async () => {
      const runCutoff = new Date("2026-07-28T03:00:00.000Z");
      const exportRepo = new FakeExportRepository();
      const eventRepo = new FakeEventRepository([], () => {
        throw new Error("mongo unavailable");
      });

      await assert.rejects(
        () => serviceWith({ eventRepo, exportRepo, now: runCutoff }).run({ runCutoff }),
        /mongo unavailable/,
      );

      assert.equal(exportRepo.validationInput, null);
      assert.equal(exportRepo.cleanupCalls, 1);
    });
  });
});

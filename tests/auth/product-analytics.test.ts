import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { ObjectId } from "mongodb";
import { indexKeyMatches, indexMatchesDesired } from "../../src/db/mongo-db-accessor.js";
import { BadRequestError } from "../../src/lib/errors.js";
import type { ProductAnalyticsEvent, User } from "../../src/models/documents.js";
import { productAnalyticsUserKeyFor } from "../../src/lib/product-analytics-user-key.js";
import { ProductAnalyticsDeletionTargetStatus } from "../../src/models/product-analytics-export.js";
import { ProductAnalyticsEventRepository } from "../../src/repositories/product-analytics-event-repo.js";
import { UserRepository } from "../../src/repositories/user-repo.js";
import { ProductAnalyticsDeletionService } from "../../src/services/product-analytics-deletion-service.js";
import { ProductAnalyticsEventService } from "../../src/services/product-analytics-event-service.js";
import { ProductAnalyticsPreferenceService } from "../../src/services/product-analytics-preference-service.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";
import {
  productAnalyticsEventBodySchema,
  ProductAnalyticsPreference,
  type ProductAnalyticsEventBody,
} from "../../src/types/product-analytics.js";
import { createTestApp, testProductAnalyticsPseudonymizationKey, type TestContext } from "../helpers/setup.js";

describe("Product analytics preference routes", () => {
  let ctx: TestContext;

  const userKeyFor = (userId: string) =>
    productAnalyticsUserKeyFor({
      userId,
      pseudonymizationKey: testProductAnalyticsPseudonymizationKey,
    });

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("requires authentication for reads and updates", async () => {
    const getResponse = await ctx.app.inject({ method: "GET", url: "/product-analytics/preference" });
    const putResponse = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: 1,
        operationId: "11111111-1111-4111-8111-111111111111",
      }),
    });

    assert.equal(getResponse.statusCode, 401);
    assert.equal(putResponse.statusCode, 401);
  });

  it("returns the versioned preference without changing auth profile contracts", async () => {
    const user = await ctx.createUser();
    const response = await ctx.app.inject({
      method: "GET",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      preference: ProductAnalyticsPreference.Enabled,
      revision: 1,
      userKey: userKeyFor(user.userId),
    });
  });

  it("fails closed if a post-start write bypasses required preference fields", async () => {
    const userId = new ObjectId();
    const createdAt = new Date("2026-06-10T10:00:00.000Z");
    await ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users).insertOne({
      _id: userId,
      tokenVersion: 0,
      createdAt,
      updatedAt: createdAt,
    });
    const accessToken = ctx.tokenService.signAccessToken({
      userId: userId.toHexString(),
      provider: "github",
      providerUserId: "legacy-provider-user",
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: "internal_server_error" });
  });

  it("keeps a permanently export-suppressed account disabled", async () => {
    const user = await ctx.createUser();
    const users = ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
    await users.updateOne(
      { _id: new ObjectId(user.userId) },
      {
        $set: {
          productAnalyticsPreference: ProductAnalyticsPreference.Disabled,
          productAnalyticsExportSuppressedAt: new Date("2026-07-28T10:00:00.000Z"),
        },
      },
    );

    const getResponse = await ctx.app.inject({
      method: "GET",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const putResponse = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({
        preference: ProductAnalyticsPreference.Enabled,
        expectedRevision: 1,
        operationId: "88888888-8888-4888-8888-888888888888",
      }),
    });

    assert.equal(getResponse.statusCode, 200);
    assert.deepEqual(getResponse.json(), {
      preference: ProductAnalyticsPreference.Disabled,
      revision: 1,
      userKey: userKeyFor(user.userId),
    });
    assert.equal(putResponse.statusCode, 409);
    assert.deepEqual(putResponse.json(), {
      error: "conflict",
      preference: ProductAnalyticsPreference.Disabled,
      revision: 1,
      userKey: userKeyFor(user.userId),
    });
  });

  it("updates by revision, replays a duplicate operation, and returns stale conflicts", async () => {
    const user = await ctx.createUser();
    const operationId = "22222222-2222-4222-8222-222222222222";
    const payload = {
      preference: ProductAnalyticsPreference.Disabled,
      expectedRevision: 1,
      operationId,
    };

    const first = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
    const duplicate = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
    const stale = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({
        preference: ProductAnalyticsPreference.Enabled,
        expectedRevision: 1,
        operationId: "33333333-3333-4333-8333-333333333333",
      }),
    });
    const mismatchedReplay = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({
        preference: ProductAnalyticsPreference.Enabled,
        expectedRevision: 1,
        operationId,
      }),
    });

    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), {
      preference: ProductAnalyticsPreference.Disabled,
      revision: 2,
      userKey: userKeyFor(user.userId),
    });
    assert.equal(duplicate.statusCode, 200);
    assert.deepEqual(duplicate.json(), first.json());
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), {
      error: "conflict",
      preference: ProductAnalyticsPreference.Disabled,
      revision: 2,
      userKey: userKeyFor(user.userId),
    });
    assert.equal(mismatchedReplay.statusCode, 409);
    assert.deepEqual(mismatchedReplay.json(), stale.json());
  });

  it("rejects an update that would exceed the maximum safe revision", async () => {
    const user = await ctx.createUser();
    const users = ctx.dbAccessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
    await users.updateOne(
      { _id: new ObjectId(user.userId) },
      { $set: { productAnalyticsPreferenceRevision: Number.MAX_SAFE_INTEGER } },
    );

    const response = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: Number.MAX_SAFE_INTEGER,
        operationId: "77777777-7777-4777-8777-777777777777",
      }),
    });

    assert.equal(response.statusCode, 400);
    assert.equal(
      (await users.findOne({ _id: new ObjectId(user.userId) }))?.productAnalyticsPreferenceRevision,
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("rejects malformed or extensible update bodies", async () => {
    const user = await ctx.createUser();
    const invalidBodies = [
      {},
      {
        preference: "unknown",
        expectedRevision: 1,
        operationId: "44444444-4444-4444-8444-444444444444",
      },
      {
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: 0,
        operationId: "44444444-4444-4444-8444-444444444444",
      },
      {
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: 1,
        operationId: "not-a-uuid",
      },
      {
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: 1,
        operationId: "44444444-4444-4444-8444-444444444444",
        userId: user.userId,
      },
    ];

    for (const body of invalidBodies) {
      const response = await ctx.app.inject({
        method: "PUT",
        url: "/product-analytics/preference",
        headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
        payload: JSON.stringify(body),
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "bad_request" });
    }
  });

  it("returns not found for preference reads and updates when the authenticated account no longer exists", async () => {
    const accessToken = ctx.tokenService.signAccessToken({
      userId: new ObjectId().toHexString(),
      provider: "github",
      providerUserId: "deleted-provider-user",
    });

    const getResponse = await ctx.app.inject({
      method: "GET",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const putResponse = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: 1,
        operationId: "99999999-9999-4999-8999-999999999999",
      }),
    });

    assert.equal(getResponse.statusCode, 404);
    assert.deepEqual(getResponse.json(), { error: "not_found" });
    assert.equal(putResponse.statusCode, 404);
    assert.deepEqual(putResponse.json(), { error: "not_found" });
  });
});

// Literal wire values rather than the TS enums: installed apps depend on these
// strings, so renaming an enum value has to fail here.
const INPUT_MODES = ["typed", "voice_assisted"];
const SUBMISSION_KINDS = ["text", "command"];
const WORKSPACE_KINDS = ["project", "dedicated_worktree", "no_project"];
const CONTENT_STATES = ["empty", "non_empty"];
const FEEDBACK_SOURCES = ["automatic", "settings"];
const SURFACES = ["connect_setup", "connected_empty", "bridge_offline"];
const INSTALL_PARAMS = { surface: SURFACES, method: ["curl", "powershell", "npm", "bun"], os: ["unix", "windows"] };

const EVENT_PARAMS: Record<string, Record<string, string[]>> = {
  analytics_schema_ready: {},
  analytics_activation_ready: { activation_schema_version: ["1"] },
  project_inventory_loaded: { inventory_state: CONTENT_STATES },
  session_activity_viewed: { activity_state: CONTENT_STATES },
  session_message_sent: { submission_kind: SUBMISSION_KINDS, input_mode: INPUT_MODES },
  session_created_with_message: {
    submission_kind: SUBMISSION_KINDS,
    input_mode: INPUT_MODES,
    workspace_kind: WORKSPACE_KINDS,
  },
  session_creation_failed: {
    failure_reason: ["not_authenticated", "server_rejected", "network_down", "bad_response", "unknown"],
    workspace_kind: WORKSPACE_KINDS,
  },
  voice_transcription_completed: {},
  session_question_answered: {},
  session_question_rejected: {},
  session_permission_answered: { decision: ["once", "always", "reject"] },
  session_abort_succeeded: {},
  session_diff_viewed: { change_state: CONTENT_STATES },
  feedback_prompt_answered: {
    answer: ["love_review_requested", "love_no_review", "could_be_better", "dismissed"],
    source: FEEDBACK_SOURCES,
  },
  private_feedback_sent: { input: ["typed", "voice_assisted", "issues_only", "empty"], source: FEEDBACK_SOURCES },
  onboarding_need_help_opened: { surface: SURFACES },
  onboarding_support_link_opened: { surface: SURFACES, channel: ["email", "discord", "x"] },
  onboarding_why_bridge_opened: { surface: SURFACES },
  bridge_install_command_copied: INSTALL_PARAMS,
  bridge_install_command_shared: INSTALL_PARAMS,
  bridge_run_command_copied: { surface: SURFACES },
  bridge_run_command_shared: { surface: SURFACES },
  product_screen_viewed: {
    screen: [
      "login",
      "projects",
      "settings",
      "settings_default_input",
      "settings_notifications",
      "settings_profile",
      "sessions",
      "new_session",
      "session_detail",
      "session_diffs",
    ],
  },
};

function paramCombinations(input: { params: Record<string, string[]> }): Record<string, string>[] {
  return Object.entries(input.params).reduce<Record<string, string>[]>(
    (combinations, [key, values]) =>
      combinations.flatMap((combination) => values.map((value) => ({ ...combination, [key]: value }))),
    [{}],
  );
}

function firstParams(input: { params: Record<string, string[]> }): Record<string, string> {
  return Object.fromEntries(Object.entries(input.params).map(([key, [value]]) => [key, value]));
}

function eventBody(input: { name: string; params: Record<string, string>; occurredAtMicros?: number }) {
  return {
    schemaVersion: 1,
    platform: "MACOS",
    appVersion: "1.2.3",
    name: input.name,
    occurredAtMicros: input.occurredAtMicros ?? Date.now() * 1000,
    params: input.params,
  };
}

const VALID_BODY = eventBody({ name: "session_permission_answered", params: { decision: "once" } });

// The global limiter exempts loopback and app.inject reports 127.0.0.1 by
// default, so rate-limit tests use a routable address to engage the route limit.
const RATE_LIMIT_CLIENT_ADDRESS = "198.51.100.61";

describe("Product analytics event schema", () => {
  it("covers exactly the 23 contract events", () => {
    assert.equal(Object.keys(EVENT_PARAMS).length, 23);
    assert.deepEqual(
      [...productAnalyticsEventBodySchema.options.map((option) => option.shape.name.value)].sort(),
      Object.keys(EVENT_PARAMS).sort(),
    );
  });

  for (const [name, params] of Object.entries(EVENT_PARAMS)) {
    it(`accepts every allowed value of ${name} and rejects anything else`, () => {
      for (const combination of paramCombinations({ params })) {
        const accepted = productAnalyticsEventBodySchema.safeParse(eventBody({ name, params: combination }));
        const isVoiceCommand = combination.submission_kind === "command" && combination.input_mode === "voice_assisted";
        assert.equal(accepted.success, !isVoiceCommand, JSON.stringify(combination));
      }

      const valid = firstParams({ params });
      const rejected: Record<string, string>[] = [
        { ...valid, unexpected: "x" },
        { ...valid, user_key: "a".repeat(64) },
      ];
      for (const key of Object.keys(params)) {
        rejected.push({ ...valid, [key]: "free text" });
        const { [key]: _omitted, ...missing } = valid;
        rejected.push(missing);
      }
      for (const invalidParams of rejected) {
        const result = productAnalyticsEventBodySchema.safeParse(eventBody({ name, params: invalidParams }));
        assert.equal(result.success, false, JSON.stringify(invalidParams));
      }
    });
  }

  const invalidEnvelopes: Array<[string, Record<string, unknown>]> = [
    ["an unknown event name", { name: "made_up_event" }],
    ["an unknown top-level field", { sessionTitle: "free text" }],
    ["a user_key field", { user_key: "a".repeat(64) }],
    ["a userKey field", { userKey: "a".repeat(64) }],
    ["another schema version", { schemaVersion: 2 }],
    ["a mobile platform", { platform: "IOS" }],
    ["a lowercase platform", { platform: "macos" }],
    ["a two-part version", { appVersion: "1.2" }],
    ["a version with a build suffix", { appVersion: "1.2.3+4" }],
    ["an oversized version part", { appVersion: "12345.0.0" }],
    ["fractional time", { occurredAtMicros: 1.5 }],
    ["zero time", { occurredAtMicros: 0 }],
    ["an unsafe integer time", { occurredAtMicros: Number.MAX_SAFE_INTEGER + 1 }],
    ["string time", { occurredAtMicros: "1790000000000000" }],
    ["missing params", { params: undefined }],
  ];

  for (const [description, override] of invalidEnvelopes) {
    it(`rejects ${description}`, () => {
      assert.equal(productAnalyticsEventBodySchema.safeParse({ ...VALID_BODY, ...override }).success, false);
    });
  }
});

describe("ProductAnalyticsEventService", () => {
  const receivedAt = new Date("2026-10-31T12:00:00.000Z");
  const receivedAtMicros = receivedAt.getTime() * 1000;
  const userKey = "a".repeat(64);

  function eventAt(input: { occurredAtMicros: number }): ProductAnalyticsEventBody {
    const result = productAnalyticsEventBodySchema.safeParse({ ...VALID_BODY, ...input });
    assert.ok(result.success);
    return result.data;
  }

  function serviceWithRecording(input: { preference: ProductAnalyticsPreference }) {
    const inserts: Array<{ userKey: string; receivedAt: Date }> = [];
    let clockReads = 0;
    const service = new ProductAnalyticsEventService({
      preferenceService: { getPreference: async () => ({ preference: input.preference, userKey }) },
      eventRepo: {
        insert: async (row) => {
          inserts.push(row);
        },
      },
      clock: () => {
        clockReads += 1;
        return receivedAt;
      },
    });
    return { service, inserts, clockReads: () => clockReads };
  }

  for (const [description, occurredAtMicros] of [
    ["exactly 72 hours old", receivedAtMicros - 72 * 3_600_000_000],
    ["exactly 300 seconds ahead", receivedAtMicros + 300_000_000],
  ] as const) {
    it(`stores an event ${description} using one clock read`, async () => {
      const { service, inserts, clockReads } = serviceWithRecording({ preference: ProductAnalyticsPreference.Enabled });

      await service.record({ userId: "user", event: eventAt({ occurredAtMicros }) });

      assert.equal(inserts.length, 1);
      assert.equal(inserts[0].userKey, userKey);
      assert.equal(inserts[0].receivedAt, receivedAt);
      assert.equal(clockReads(), 1);
    });
  }

  for (const [description, occurredAtMicros] of [
    ["older than 72 hours", receivedAtMicros - 72 * 3_600_000_000 - 1],
    ["more than 300 seconds ahead", receivedAtMicros + 300_000_000 + 1],
  ] as const) {
    it(`rejects an event ${description}`, async () => {
      const { service, inserts } = serviceWithRecording({ preference: ProductAnalyticsPreference.Enabled });

      await assert.rejects(
        () => service.record({ userId: "user", event: eventAt({ occurredAtMicros }) }),
        (error: unknown) => error instanceof BadRequestError,
      );
      assert.equal(inserts.length, 0);
    });
  }

  it("stores nothing when the preference is not enabled", async () => {
    const { service, inserts } = serviceWithRecording({ preference: ProductAnalyticsPreference.Disabled });

    await service.record({ userId: "user", event: eventAt({ occurredAtMicros: receivedAtMicros }) });

    assert.equal(inserts.length, 0);
  });
});

describe("POST /product-analytics/events", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  function eventCollection() {
    return ctx.dbAccessor.getCollection<ProductAnalyticsEvent>(
      MongoDbDatabase.Auth,
      AuthDbCollection.ProductAnalyticsEvents,
    );
  }

  function rowsFor(input: { userId: string }) {
    return eventCollection()
      .find({
        userKey: productAnalyticsUserKeyFor({ ...input, pseudonymizationKey: testProductAnalyticsPseudonymizationKey }),
      })
      .toArray();
  }

  function postRaw(input: { accessToken?: string; payload: string; remoteAddress?: string }) {
    return ctx.app.inject({
      method: "POST",
      url: "/product-analytics/events",
      headers: {
        ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {}),
        "content-type": "application/json",
      },
      payload: input.payload,
      ...(input.remoteAddress ? { remoteAddress: input.remoteAddress } : {}),
    });
  }

  function post(input: { accessToken?: string; body: unknown; remoteAddress?: string }) {
    return postRaw({ ...input, payload: JSON.stringify(input.body) });
  }

  for (const [name, params] of Object.entries(EVENT_PARAMS)) {
    it(`stores ${name} with an empty 204 and a server-derived key`, async () => {
      const user = await ctx.createUser();
      const body = eventBody({ name, params: firstParams({ params }) });
      const startedAt = Date.now();

      const response = await post({ accessToken: user.accessToken, body });

      assert.equal(response.statusCode, 204);
      assert.equal(response.body, "");
      const [row, ...others] = await rowsFor({ userId: user.userId });
      assert.ok(row);
      assert.equal(others.length, 0);
      const { _id, receivedAt, ...stored } = row;
      assert.ok(_id instanceof ObjectId);
      assert.ok(receivedAt.getTime() >= startedAt && receivedAt.getTime() <= Date.now());
      assert.deepEqual(stored, {
        userKey: productAnalyticsUserKeyFor({
          userId: user.userId,
          pseudonymizationKey: testProductAnalyticsPseudonymizationKey,
        }),
        eventName: name,
        occurredAtMicros: body.occurredAtMicros,
        schemaVersion: 1,
        platform: "MACOS",
        appVersion: "1.2.3",
        params: body.params,
      });
    });
  }

  const rejectedBodies: Array<[string, unknown]> = [
    ["an unknown event name", { ...VALID_BODY, name: "made_up_event" }],
    ["an unknown param", { ...VALID_BODY, params: { decision: "once", extra: "x" } }],
    ["an unknown top-level field", { ...VALID_BODY, extra: "x" }],
    ["a user_key field", { ...VALID_BODY, user_key: "a".repeat(64) }],
    ["free text in a param", { ...VALID_BODY, params: { decision: "fix the login bug" } }],
    [
      "a voice-assisted command",
      eventBody({ name: "session_message_sent", params: { submission_kind: "command", input_mode: "voice_assisted" } }),
    ],
    ["time older than 72 hours", { ...VALID_BODY, occurredAtMicros: (Date.now() - 73 * 3_600_000) * 1000 }],
    ["time over 300 seconds ahead", { ...VALID_BODY, occurredAtMicros: (Date.now() + 3_600_000) * 1000 }],
    ["a body that is not an object", ["session_permission_answered"]],
  ];

  for (const [description, body] of rejectedBodies) {
    it(`rejects ${description} with 400 and stores nothing`, async () => {
      const user = await ctx.createUser();

      const response = await post({ accessToken: user.accessToken, body });

      assert.equal(response.statusCode, 400);
      assert.deepEqual(await rowsFor({ userId: user.userId }), []);
    });
  }

  it("logs only issue codes and paths for a rejected body", async () => {
    const user = await ctx.createUser();
    const errorLog = mock.method(console, "error", () => {});

    try {
      const unknownKeys = await post({
        accessToken: user.accessToken,
        body: {
          ...VALID_BODY,
          secret_top_level_key: "secret-top-level-value",
          params: { decision: "once", secret_param_key: "secret-param-value" },
        },
      });
      const badValue = await post({
        accessToken: user.accessToken,
        body: { ...VALID_BODY, appVersion: "secret-version", params: { decision: "secret-decision" } },
      });
      const unknownName = await post({ accessToken: user.accessToken, body: { ...VALID_BODY, name: "secret-name" } });
      const stale = await post({ accessToken: user.accessToken, body: { ...VALID_BODY, occurredAtMicros: 987654321 } });
      const malformed = await postRaw({ accessToken: user.accessToken, payload: '{"secret-malformed":' });

      for (const response of [unknownKeys, badValue, unknownName, stale, malformed]) {
        assert.equal(response.statusCode, 400);
      }
      for (const response of [unknownKeys, badValue, unknownName, stale]) {
        assert.equal(response.body.includes("secret"), false);
      }
      assert.ok(errorLog.mock.callCount() > 0, "the rejection is still logged");
      const logged = JSON.stringify(errorLog.mock.calls.map((call) => call.arguments));
      assert.ok(logged.includes("unrecognized_keys"));
      assert.equal(logged.includes("secret"), false);
      assert.equal(logged.includes("987654321"), false);
      assert.equal(logged.includes(user.accessToken), false);
      assert.equal(logged.includes(user.userId), false);
    } finally {
      errorLog.mock.restore();
    }
  });

  it("rejects an unauthenticated event with 401", async () => {
    assert.equal((await post({ body: VALID_BODY })).statusCode, 401);
  });

  it("returns 404 when the authenticated account no longer exists", async () => {
    const accessToken = ctx.tokenService.signAccessToken({
      userId: new ObjectId().toHexString(),
      provider: "github",
      providerUserId: "deleted-provider-user",
    });

    assert.equal((await post({ accessToken, body: VALID_BODY })).statusCode, 404);
  });

  it("stores nothing and returns 204 when the preference is off", async () => {
    const user = await ctx.createUser();
    const update = await ctx.app.inject({
      method: "PUT",
      url: "/product-analytics/preference",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({
        preference: ProductAnalyticsPreference.Disabled,
        expectedRevision: 1,
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    });
    assert.equal(update.statusCode, 200);

    const response = await post({ accessToken: user.accessToken, body: VALID_BODY });

    assert.equal(response.statusCode, 204);
    assert.equal(response.body, "");
    assert.deepEqual(await rowsFor({ userId: user.userId }), []);
  });

  it("stores a repeated body once and answers both with 204", async () => {
    const user = await ctx.createUser();

    const first = await post({ accessToken: user.accessToken, body: VALID_BODY });
    const repeat = await post({ accessToken: user.accessToken, body: VALID_BODY });

    assert.equal(first.statusCode, 204);
    assert.equal(repeat.statusCode, 204);
    assert.equal((await rowsFor({ userId: user.userId })).length, 1);
  });

  it("limits each account to 60 events per minute without affecting other accounts", async () => {
    const user = await ctx.createUser();
    const other = await ctx.createUser();
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 61; attempt += 1) {
      const response = await post({
        accessToken: user.accessToken,
        body: VALID_BODY,
        remoteAddress: RATE_LIMIT_CLIENT_ADDRESS,
      });
      statuses.push(response.statusCode);
    }

    assert.deepEqual(statuses.slice(0, 60), Array(60).fill(204));
    assert.equal(statuses[60], 429);
    const otherResponse = await post({
      accessToken: other.accessToken,
      body: VALID_BODY,
      remoteAddress: RATE_LIMIT_CLIENT_ADDRESS,
    });
    assert.equal(otherResponse.statusCode, 204);
  });

  it("rejects a body over 1024 bytes with 413", async () => {
    const user = await ctx.createUser();
    const payload = JSON.stringify({ ...VALID_BODY, padding: "x".repeat(1024) });

    assert.equal((await postRaw({ accessToken: user.accessToken, payload })).statusCode, 413);
    assert.deepEqual(await rowsFor({ userId: user.userId }), []);
  });

  it("creates the unique and TTL indexes and recognizes them on a second run", async () => {
    const unique = { spec: { userKey: 1, eventName: 1, occurredAtMicros: 1 }, options: { unique: true } } as const;
    const ttl = { spec: { receivedAt: 1 }, options: { expireAfterSeconds: 777_600 } } as const;
    const before = await eventCollection().indexes();
    const warnLog = mock.method(console, "warn", () => {});

    try {
      await ctx.dbAccessor.ensureIndexes();
      assert.equal(warnLog.mock.callCount(), 0);
    } finally {
      warnLog.mock.restore();
    }

    const indexes = await eventCollection().indexes();
    assert.deepEqual(indexes, before);
    assert.equal(indexes.length, 3);
    assert.ok(indexes.some((index) => indexMatchesDesired(index, unique)));
    assert.ok(indexes.some((index) => indexMatchesDesired(index, ttl)));
    assert.equal(indexes.find((index) => indexKeyMatches(index.key, ttl.spec))?.expireAfterSeconds, 777_600);
  });

  it("suppression removes only that account's rows and blocks later events", async () => {
    const suppressed = await ctx.createUser();
    const other = await ctx.createUser();
    for (const user of [suppressed, other]) {
      assert.equal((await post({ accessToken: user.accessToken, body: VALID_BODY })).statusCode, 204);
    }
    const deletion = new ProductAnalyticsDeletionService({
      preferenceService: new ProductAnalyticsPreferenceService({
        userRepo: new UserRepository(ctx.dbAccessor),
        pseudonymizationKey: testProductAnalyticsPseudonymizationKey,
      }),
      deletionTargetRepo: {
        handoff: async ({ requestId }) => ({ requestId, status: ProductAnalyticsDeletionTargetStatus.Pending }),
      },
      eventRepo: new ProductAnalyticsEventRepository({ accessor: ctx.dbAccessor }),
    });

    await deletion.suppressAndHandoff({ userId: suppressed.userId, requestId: "privacy_request_001" });
    // A retry after a partial failure has to stay safe.
    await deletion.suppressAndHandoff({ userId: suppressed.userId, requestId: "privacy_request_001" });

    assert.deepEqual(await rowsFor({ userId: suppressed.userId }), []);
    assert.equal((await rowsFor({ userId: other.userId })).length, 1);

    const afterSuppression = await post({
      accessToken: suppressed.accessToken,
      body: { ...VALID_BODY, occurredAtMicros: VALID_BODY.occurredAtMicros + 1 },
    });
    assert.equal(afterSuppression.statusCode, 204);
    assert.deepEqual(await rowsFor({ userId: suppressed.userId }), []);
  });
});

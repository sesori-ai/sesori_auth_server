import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { after, before, describe, it } from "node:test";
import { OptionalEmailPreferenceRepository } from "../../src/repositories/optional-email-preference-repo.js";
import { optionalEmailUnsubscribeRoutes } from "../../src/routes/optional-email-unsubscribe.js";
import {
  OptionalEmailUnsubscribeService,
  OptionalEmailUnsubscribeTokenService,
  buildOptionalEmailUnsubscribeHeaders,
} from "../../src/services/optional-email-unsubscribe-service.js";
import { OptionalEmailBlockReason } from "../../src/types/optional-email.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

const SECRET = Buffer.alloc(32, 7);
const NOW = new Date("2026-09-06T12:00:00.000Z");

describe("optional email unsubscribe token and headers", () => {
  it("rejects weak signing secrets and malformed user ids", () => {
    assert.throws(
      () => new OptionalEmailUnsubscribeTokenService({ signingSecret: Buffer.alloc(31) }),
      /OptionalEmailUnsubscribeSigningSecretTooShort/,
    );
    const tokens = new OptionalEmailUnsubscribeTokenService({ signingSecret: SECRET });
    assert.throws(() => tokens.create({ userId: "not-an-object-id" }), /InvalidOptionalEmailUnsubscribeUserId/);
  });

  it("round-trips a signed persistent token and rejects tampering", () => {
    const tokens = new OptionalEmailUnsubscribeTokenService({ signingSecret: SECRET });
    const userId = "000000000000000000000001";

    const token = tokens.create({ userId });

    assert.equal(tokens.verify({ token }), userId);
    const finalCharacter = token.endsWith("a") ? "b" : "a";
    assert.equal(tokens.verify({ token: `${token.slice(0, -1)}${finalCharacter}` }), null);
    assert.equal(tokens.verify({ token: "not-a-token" }), null);
  });

  it("builds the RFC 8058 one-click headers against the signed no-login URL", () => {
    const tokens = new OptionalEmailUnsubscribeTokenService({ signingSecret: SECRET });
    const token = tokens.create({ userId: "000000000000000000000001" });

    const result = buildOptionalEmailUnsubscribeHeaders({
      publicBaseUrl: "https://api.sesori.com",
      token,
    });

    assert.deepEqual(result, {
      "List-Unsubscribe": `<https://api.sesori.com/email/optional/unsubscribe?token=${encodeURIComponent(token)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    assert.throws(
      () => buildOptionalEmailUnsubscribeHeaders({ publicBaseUrl: "http://api.sesori.com", token }),
      /InvalidOptionalEmailPublicBaseUrl/,
    );
  });
});

describe("optional email unsubscribe routes", () => {
  let ctx: TestContext;
  let preferenceRepo: OptionalEmailPreferenceRepository;
  let tokens: OptionalEmailUnsubscribeTokenService;
  let app: FastifyInstance;

  before(async () => {
    ctx = await createTestApp();
    preferenceRepo = new OptionalEmailPreferenceRepository(ctx.dbAccessor);
    tokens = new OptionalEmailUnsubscribeTokenService({ signingSecret: SECRET });
    const service = new OptionalEmailUnsubscribeService({
      preferenceRepo,
      tokenService: tokens,
      clock: () => NOW,
    });
    app = Fastify();
    await app.register(optionalEmailUnsubscribeRoutes, { service });
    await app.ready();
  });

  after(async () => {
    await app.close();
    await ctx.cleanup();
  });

  it("shows a confirmation form on GET without changing preference state", async () => {
    const user = await ctx.createUser();
    const token = tokens.create({ userId: user.userId });

    const response = await app.inject({
      method: "GET",
      url: `/email/optional/unsubscribe?token=${encodeURIComponent(token)}`,
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /^text\/html/);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.match(response.headers["content-security-policy"] ?? "", /form-action 'self'/);
    assert.match(response.body, /Unsubscribe from optional Sesori setup reminders/);
    assert.match(response.body, /method="post"/);
    assert.equal(await preferenceRepo.findBlockReason({ userId: user.userId }), null);
  });

  it("accepts an unauthenticated RFC 8058 POST and remains idempotent on replay", async () => {
    const user = await ctx.createUser();
    const token = tokens.create({ userId: user.userId });
    const request = {
      method: "POST" as const,
      url: `/email/optional/unsubscribe?token=${encodeURIComponent(token)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    assert.equal(first.statusCode, 200);
    assert.equal(first.body, "");
    assert.equal(first.headers["cache-control"], "no-store");
    assert.equal(replay.statusCode, 200);
    assert.equal(await preferenceRepo.findBlockReason({ userId: user.userId }), OptionalEmailBlockReason.Unsubscribed);
    assert.equal(
      (await preferenceRepo.findByUserId({ userId: user.userId }))?.unsubscribedAt?.toISOString(),
      NOW.toISOString(),
    );
  });

  it("rejects a tampered token and malformed one-click body without writing", async () => {
    const user = await ctx.createUser();
    const token = tokens.create({ userId: user.userId });
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    const badToken = await app.inject({
      method: "POST",
      url: `/email/optional/unsubscribe?token=${encodeURIComponent(tampered)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    });
    const badBody = await app.inject({
      method: "POST",
      url: `/email/optional/unsubscribe?token=${encodeURIComponent(token)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=No",
    });
    const extraField = await app.inject({
      method: "POST",
      url: `/email/optional/unsubscribe?token=${encodeURIComponent(token)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click&confirm=yes",
    });
    const duplicateField = await app.inject({
      method: "POST",
      url: `/email/optional/unsubscribe?token=${encodeURIComponent(token)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click&List-Unsubscribe=One-Click",
    });

    assert.equal(badToken.statusCode, 400);
    assert.equal(badBody.statusCode, 400);
    assert.equal(extraField.statusCode, 400);
    assert.equal(duplicateField.statusCode, 400);
    assert.equal(await preferenceRepo.findByUserId({ userId: user.userId }), null);
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createTestApp, type TestContext } from "../helpers/setup.js";

// The global limiter exempts loopback, and app.inject reports 127.0.0.1 by
// default, so every request here comes from a routable address to make the
// per-route limit actually engage.
const CLIENT_ADDRESS = "203.0.113.9";

describe("settings write rate limit", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("throttles a client that floods writes with fresh device ids", async () => {
    const user = await ctx.createUser();
    const headers = { authorization: `Bearer ${user.accessToken}` };

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/auth/settings/${randomUUID()}`,
        headers,
        remoteAddress: CLIENT_ADDRESS,
        payload: { notifications: { aiInteraction: false } },
      });
      statuses.push(response.statusCode);
    }

    assert.ok(
      statuses.includes(429),
      `expected the burst to be throttled, saw ${JSON.stringify([...new Set(statuses)])}`,
    );
    assert.equal(statuses[0], 200, "the first write must still succeed");

    const accepted = statuses.filter((status) => status === 200).length;
    assert.ok(accepted <= 30, `expected at most the configured allowance, got ${accepted}`);
  });

  // Refreshing mints a new access-token string, so keying on the token itself
  // would hand the same account a fresh allowance on demand.
  it("keeps throttling after the client refreshes its access token", async () => {
    const user = await ctx.createUser();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await ctx.app.inject({
        method: "PATCH",
        url: `/auth/settings/${randomUUID()}`,
        headers: { authorization: `Bearer ${user.accessToken}` },
        remoteAddress: CLIENT_ADDRESS,
        payload: { notifications: { aiInteraction: false } },
      });
    }

    // iat/exp are second-granularity, so a same-second refresh returns a byte
    // identical token and would not exercise the bypass at all.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: user.refreshToken },
    });
    assert.equal(refreshed.statusCode, 200);
    const rotatedToken = refreshed.json().accessToken;
    assert.notEqual(rotatedToken, user.accessToken, "the refresh must actually rotate the token string");

    const afterRefresh = await ctx.app.inject({
      method: "PATCH",
      url: `/auth/settings/${randomUUID()}`,
      headers: { authorization: `Bearer ${rotatedToken}` },
      remoteAddress: CLIENT_ADDRESS,
      payload: { notifications: { aiInteraction: false } },
    });

    assert.equal(afterRefresh.statusCode, 429, "a rotated token must not reset the write allowance");
  });

  // Keying on an unverified claim would let anyone forge a Bearer carrying a
  // known userId and exhaust that account's allowance without authenticating.
  it("cannot be filled for another account with a forged bearer token", async () => {
    const victim = await ctx.createUser();
    const forgedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8").toString("base64url");
    const forgedClaims = Buffer.from(
      JSON.stringify({ tokenType: "access", userId: victim.userId, provider: "github", providerUserId: "1" }),
      "utf8",
    ).toString("base64url");
    const forgedToken = `${forgedHeader}.${forgedClaims}.not-a-real-signature`;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const rejected = await ctx.app.inject({
        method: "PATCH",
        url: `/auth/settings/${randomUUID()}`,
        headers: { authorization: `Bearer ${forgedToken}` },
        remoteAddress: "198.51.100.7",
        payload: { notifications: { aiInteraction: false } },
      });
      assert.ok(
        rejected.statusCode === 401 || rejected.statusCode === 429,
        `a forged token must never be accepted, got ${rejected.statusCode}`,
      );
    }

    const legitimate = await ctx.app.inject({
      method: "PATCH",
      url: `/auth/settings/${randomUUID()}`,
      headers: { authorization: `Bearer ${victim.accessToken}` },
      remoteAddress: CLIENT_ADDRESS,
      payload: { notifications: { aiInteraction: false } },
    });

    assert.equal(legitimate.statusCode, 200, "the victim's own writes must be unaffected by forged traffic");
  });

  it("does not throttle reads for a client that exhausted its write allowance", async () => {
    const user = await ctx.createUser();
    const headers = { authorization: `Bearer ${user.accessToken}` };
    const deviceId = randomUUID();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await ctx.app.inject({
        method: "PATCH",
        url: `/auth/settings/${randomUUID()}`,
        headers,
        remoteAddress: CLIENT_ADDRESS,
        payload: { notifications: { aiInteraction: false } },
      });
    }

    const read = await ctx.app.inject({
      method: "GET",
      url: `/auth/settings/${deviceId}`,
      headers,
      remoteAddress: CLIENT_ADDRESS,
    });

    assert.equal(read.statusCode, 200);
    assert.equal(read.json().notifications.aiInteraction, true);
  });
});

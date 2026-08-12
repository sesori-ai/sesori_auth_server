import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createTestApp, type TestContext } from "../helpers/setup.js";

// The global limiter exempts loopback, and app.inject reports 127.0.0.1 by
// default, so every request here comes from a routable address to make the
// per-route limit actually engage.
//
// Each test takes its OWN address. The global limiter allows 100/min per
// resolved IP while this file sends several hundred requests in total, so a
// shared address would let a global 429 masquerade as the per-route limit under
// test, and would make the result depend on where the one-minute windows happen
// to fall rather than on the behaviour being pinned.
let addressCounter = 0;
function nextClientAddress(): string {
  addressCounter += 1;
  return `203.0.113.${addressCounter}`;
}

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
    const clientAddress = nextClientAddress();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/auth/settings/${randomUUID()}`,
        headers,
        remoteAddress: clientAddress,
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
    const clientAddress = nextClientAddress();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await ctx.app.inject({
        method: "PATCH",
        url: `/auth/settings/${randomUUID()}`,
        headers: { authorization: `Bearer ${user.accessToken}` },
        remoteAddress: clientAddress,
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
      remoteAddress: clientAddress,
      payload: { notifications: { aiInteraction: false } },
    });

    assert.equal(afterRefresh.statusCode, 429, "a rotated token must not reset the write allowance");
  });

  // Keying on an unverified claim would let anyone forge a Bearer carrying a
  // known userId and exhaust that account's allowance without authenticating.
  it("cannot be filled for another account with a forged bearer token", async () => {
    const victim = await ctx.createUser();
    const clientAddress = nextClientAddress();
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
      remoteAddress: clientAddress,
      payload: { notifications: { aiInteraction: false } },
    });

    assert.equal(legitimate.statusCode, 200, "the victim's own writes must be unaffected by forged traffic");
  });

  it("does not throttle reads for a client that exhausted its write allowance", async () => {
    const user = await ctx.createUser();
    const headers = { authorization: `Bearer ${user.accessToken}` };
    const deviceId = randomUUID();
    const clientAddress = nextClientAddress();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await ctx.app.inject({
        method: "PATCH",
        url: `/auth/settings/${randomUUID()}`,
        headers,
        remoteAddress: clientAddress,
        payload: { notifications: { aiInteraction: false } },
      });
    }

    const read = await ctx.app.inject({
      method: "GET",
      url: `/auth/settings/${deviceId}`,
      headers,
      remoteAddress: clientAddress,
    });

    assert.equal(read.statusCode, 200);
    assert.equal(read.json().notifications.aiInteraction, true);
  });

  it("throttles a client that floods deletes", async () => {
    const user = await ctx.createUser();
    const headers = { authorization: `Bearer ${user.accessToken}` };
    const clientAddress = nextClientAddress();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await ctx.app.inject({
        method: "DELETE",
        url: "/auth/settings",
        headers,
        remoteAddress: clientAddress,
      });
      statuses.push(response.statusCode);
    }

    assert.ok(
      statuses.includes(429),
      `expected the burst to be throttled, saw ${JSON.stringify([...new Set(statuses)])}`,
    );
    assert.equal(statuses[0], 200, "the first delete must still succeed");

    const accepted = statuses.filter((status) => status === 200).length;
    assert.ok(accepted <= 30, `expected at most the configured allowance, got ${accepted}`);
  });

  // The plugin counts per route, so exhausting one verb must not spend the
  // other's allowance. This pins that behaviour: the documented budget is 30 per
  // verb, and a change that pooled them would halve what clients may do.
  it("keeps the delete and patch allowances independent", async () => {
    const user = await ctx.createUser();
    const headers = { authorization: `Bearer ${user.accessToken}` };
    const clientAddress = nextClientAddress();

    const patchStatuses: number[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/auth/settings/${randomUUID()}`,
        headers,
        remoteAddress: clientAddress,
        payload: { notifications: { aiInteraction: false } },
      });
      patchStatuses.push(response.statusCode);
    }

    // Without this the test proves nothing: if PATCH limiting were broken the
    // flood would never exhaust anything, and the DELETE below would pass for
    // the trivial reason that no budget was ever spent.
    assert.ok(
      patchStatuses.includes(429),
      `the PATCH budget must actually be exhausted first, saw ${JSON.stringify([...new Set(patchStatuses)])}`,
    );

    const removed = await ctx.app.inject({
      method: "DELETE",
      url: "/auth/settings",
      headers,
      remoteAddress: clientAddress,
    });

    assert.equal(removed.statusCode, 200, "an exhausted PATCH budget must not throttle DELETE");
  });
});

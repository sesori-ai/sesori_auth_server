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

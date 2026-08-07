import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveRateLimitAllowList } from "../src/server.js";

describe("resolveRateLimitAllowList", () => {
  it("exempts loopback only when proxy headers are not trusted", () => {
    assert.deepEqual(resolveRateLimitAllowList(false), ["127.0.0.1", "::1"]);
  });

  // With proxies trusted, request.ip comes from X-Forwarded-For, so keeping the
  // loopback entries would let a client send 127.0.0.1 and skip rate limiting.
  it("exempts nothing once proxy headers are trusted", () => {
    assert.deepEqual(resolveRateLimitAllowList(true), []);
    assert.deepEqual(resolveRateLimitAllowList(1), []);
    assert.deepEqual(resolveRateLimitAllowList(3), []);
  });
});

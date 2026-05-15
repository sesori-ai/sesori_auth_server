import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { PendingAuthStore } from "../../src/services/pending-auth-store.js";
import { OAuthProviderName } from "../../src/types/oauth.js";

function createSessionTokenHash(token = "session-token"): string {
  return PendingAuthStore.hashToken(token);
}

function createStore(overrides?: ConstructorParameters<typeof PendingAuthStore>[0]): PendingAuthStore {
  return new PendingAuthStore({
    sessionTtlMs: 5 * 60 * 1000,
    userCodeGenerator: () => "AB12",
    ...overrides,
  });
}

describe("PendingAuthStore", () => {
  it("creates sessions with hashed-token lookup and user-code lookup", () => {
    const store = createStore();
    const tokenHash = createSessionTokenHash();

    const created = store.createSession({
      tokenHash,
      provider: OAuthProviderName.Github,
      pkceVerifier: "pkce-verifier",
      state: "oauth-state",
    });

    const byTokenHash = store.getSessionByTokenHash(tokenHash);
    const byUserCode = store.getSessionByUserCode(created.userCode);

    assert.equal(created.tokenHash, tokenHash);
    assert.equal(created.provider, OAuthProviderName.Github);
    assert.equal(created.pkceVerifier, "pkce-verifier");
    assert.equal(created.state, "oauth-state");
    assert.equal(created.status, "pending");
    assert.equal(created.userCode, "AB12");
    assert.match(created.userCode, /^[A-Z0-9]{4}$/);
    assert.ok(created.createdAt instanceof Date);
    assert.ok(created.expiresAt instanceof Date);
    assert.deepEqual(byTokenHash, created);
    assert.deepEqual(byUserCode, created);
  });

  it("wakes long-poll waiters when a session completes", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const store = createStore();
      const tokenHash = createSessionTokenHash();
      store.createSession({
        tokenHash,
        provider: OAuthProviderName.Google,
        pkceVerifier: "pkce-verifier",
        state: "oauth-state",
      });

      const waitPromise = store.waitForStatusChange(tokenHash, 5_000);

      const updated = store.completeSession({
        tokenHash,
        tokens: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
        },
        user: {
          id: "user-1",
          provider: "google",
          providerUserId: "provider-user-1",
          providerUsername: "octocat",
        },
      });

      const waited = await waitPromise;

      assert.equal(updated?.status, "complete");
      assert.deepEqual(waited, updated);
    } finally {
      mock.timers.reset();
    }
  });

  it("returns the current session when long-poll timeout elapses without a status change", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const store = createStore();
      const tokenHash = createSessionTokenHash();
      store.createSession({
        tokenHash,
        provider: OAuthProviderName.Google,
        pkceVerifier: "pkce-verifier",
        state: "oauth-state",
      });

      const waitPromise = store.waitForStatusChange(tokenHash, 250);
      mock.timers.tick(250);

      const waited = await waitPromise;

      assert.equal(waited?.status, "pending");
      assert.equal(waited?.tokenHash, tokenHash);
    } finally {
      mock.timers.reset();
    }
  });

  it("expires sessions and releases waiters", async () => {
    let currentTime = new Date("2026-05-14T12:00:00.000Z");
    const store = createStore({
      sessionTtlMs: 1_000,
      now: () => currentTime,
    });
    const tokenHash = createSessionTokenHash();

    const created = store.createSession({
      tokenHash,
      provider: OAuthProviderName.Apple,
      pkceVerifier: "pkce-verifier",
      state: "oauth-state",
    });

    const waitPromise = store.waitForStatusChange(tokenHash, 5_000);
    currentTime = new Date(created.expiresAt.getTime());
    store.expireExpiredSessions();

    const waited = await waitPromise;

    assert.equal(waited?.status, "expired");
    assert.equal(store.getSessionByTokenHash(tokenHash), null);
    assert.equal(store.getSessionByUserCode(created.userCode), null);
  });

  it("tracks denial and error terminal states", async () => {
    const store = createStore({
      userCodeGenerator: (() => {
        const codes = ["AB12", "CD34"];
        return () => {
          const nextCode = codes.shift();
          assert.ok(nextCode);
          return nextCode;
        };
      })(),
    });

    const deniedTokenHash = createSessionTokenHash("denied-token");
    store.createSession({
      tokenHash: deniedTokenHash,
      provider: OAuthProviderName.Github,
      pkceVerifier: "pkce-denied",
      state: "state-denied",
    });
    const denied = store.denySession(deniedTokenHash);

    const errorTokenHash = createSessionTokenHash("error-token");
    store.createSession({
      tokenHash: errorTokenHash,
      provider: OAuthProviderName.Google,
      pkceVerifier: "pkce-error",
      state: "state-error",
    });
    const errored = store.failSession({
      tokenHash: errorTokenHash,
      errorMessage: "oauth_exchange_failed",
    });

    assert.equal(denied?.status, "denied");
    assert.equal(store.getSessionByTokenHash(deniedTokenHash)?.status, "denied");
    assert.equal(errored?.status, "error");
    assert.equal(errored?.errorMessage, "oauth_exchange_failed");
    assert.equal(store.getSessionByTokenHash(errorTokenHash)?.errorMessage, "oauth_exchange_failed");
  });

  it("consumes completed sessions only once and deletes them afterward", () => {
    const store = createStore();
    const tokenHash = createSessionTokenHash();
    store.createSession({
      tokenHash,
      provider: OAuthProviderName.Github,
      pkceVerifier: "pkce-verifier",
      state: "oauth-state",
    });

    store.completeSession({
      tokenHash,
      tokens: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
      user: {
        id: "user-1",
        provider: "github",
        providerUserId: "provider-user-1",
        providerUsername: "octocat",
      },
    });

    const firstConsume = store.consumeCompletion(tokenHash);
    const secondConsume = store.consumeCompletion(tokenHash);
    const afterConsume = store.getSessionByTokenHash(tokenHash);

    assert.deepEqual(firstConsume, {
      tokens: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
      user: {
        id: "user-1",
        provider: "github",
        providerUserId: "provider-user-1",
        providerUsername: "octocat",
      },
    });
    assert.equal(secondConsume, null);
    assert.equal(afterConsume, null);
  });

  it("notifies all simultaneous waiters once on a status change (CQ-7)", async () => {
    const store = createStore();
    const tokenHash = createSessionTokenHash();
    store.createSession({
      tokenHash,
      provider: OAuthProviderName.Github,
      pkceVerifier: "pkce-verifier",
      state: "oauth-state",
    });

    const waiterA = store.waitForStatusChange(tokenHash, 5_000);
    const waiterB = store.waitForStatusChange(tokenHash, 5_000);
    const waiterC = store.waitForStatusChange(tokenHash, 5_000);

    store.denySession(tokenHash);

    const [a, b, c] = await Promise.all([waiterA, waiterB, waiterC]);
    assert.equal(a?.status, "denied");
    assert.equal(b?.status, "denied");
    assert.equal(c?.status, "denied");
  });
});

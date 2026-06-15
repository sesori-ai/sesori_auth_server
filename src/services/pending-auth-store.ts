import crypto from "node:crypto";
import { LRUCache } from "lru-cache";
import type { OAuthClientType, UserProfile } from "../models/api.js";
import { OAuthProviderName } from "../types/oauth.js";

/**
 * In-memory store of pending OAuth sign-in sessions used for the anti-phishing
 * confirmation flow.
 *
 * State machine:
 *
 *     pending ──(provider redirect arrives)──▶ awaiting_confirmation
 *                                                     │
 *                                     ┌──(user confirms)─▶ complete ──▶ consumed (deleted)
 *                                     └──(user denies)───▶ denied
 *     * ──(TTL elapsed)──▶ expired (no-op, just notifies waiters; entry deleted)
 *     * ──(OAuth exchange failed)──▶ error
 *
 * Bounded LRU + TTL. **Single-instance only**: pending sessions live in this
 * process's memory and are NOT visible to other instances. Horizontal scaling
 * requires sticky sessions or migrating to Redis.
 *
 * Memory footprint: ~1 KB per entry × max entries. Default max is 10k entries,
 * configurable via constructor `maxSessions` (and via `PENDING_AUTH_MAX_SESSIONS`
 * env when wired through `src/config.ts`).
 *
 * Expiry strategy: lazy on read (`#getActiveEntry`) plus the LRU cap. We do
 * NOT schedule per-entry timers — that would queue 10k callbacks under load.
 */

const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 10_000;

// User-visible 4-character code for anti-phishing visual matching only.
// Crockford-style alphabet (omits I/O/0/1 to avoid OCR/handwriting ambiguity).
// 32^4 ≈ 1M codes — sufficient for visual uniqueness within the 5-min TTL
// window. NOT used as a server-side validation token.
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 4;
const USER_CODE_REGEX = /^[A-Z0-9]{4}$/;

export enum PendingAuthStatus {
  Pending = "pending",
  AwaitingConfirmation = "awaiting_confirmation",
  Complete = "complete",
  Consumed = "consumed",
  Denied = "denied",
  Expired = "expired",
  Error = "error",
}

export type PendingAuthTokens = {
  accessToken: string;
  refreshToken: string;
};

export type PendingAuthSession = {
  tokenHash: string;
  provider: OAuthProviderName;
  pkceVerifier: string;
  state: string;
  userCode: string;
  status: PendingAuthStatus;
  createdAt: Date;
  expiresAt: Date;
  /** Tokens delivered to the client on `consumeCompletion`. Only present when `status === "complete"`. */
  tokens?: PendingAuthTokens;
  user?: UserProfile;
  /** Provider error message when `status === "error"`. */
  errorMessage?: string;
  /** Client type (bridge / app / per-platform). Recorded at init for audit. */
  clientType?: OAuthClientType;
};

type PendingAuthStoreEntry = {
  session: PendingAuthSessionRecord;
};

type PendingAuthSessionRecord = PendingAuthSession & {
  /** Tokens held during `awaiting_confirmation`; promoted to `tokens` on confirm. */
  stagedTokens?: PendingAuthTokens;
  stagedUser?: UserProfile;
};

type StatusWaiter = {
  initialStatus: PendingAuthStatus;
  resolve: (session: PendingAuthSession | null) => void;
  timeout: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
};

export class PendingAuthStore {
  readonly #sessions: LRUCache<string, PendingAuthStoreEntry>;
  readonly #tokenHashesByState = new Map<string, string>();
  readonly #tokenHashesByUserCode = new Map<string, string>();
  readonly #waitersByTokenHash = new Map<string, Set<StatusWaiter>>();
  readonly #sessionTtlMs: number;
  readonly #userCodeGenerator: () => string;
  readonly #now: () => Date;

  constructor(deps?: {
    sessionTtlMs?: number;
    maxSessions?: number;
    userCodeGenerator?: () => string;
    now?: () => Date;
  }) {
    this.#sessionTtlMs = deps?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#userCodeGenerator = deps?.userCodeGenerator ?? (() => this.#createUserCode());
    this.#now = deps?.now ?? (() => new Date());

    this.#sessions = new LRUCache<string, PendingAuthStoreEntry>({
      max: deps?.maxSessions ?? DEFAULT_MAX_SESSIONS,
      noDisposeOnSet: true,
      dispose: (entry) => {
        this.#tokenHashesByState.delete(entry.session.state);
        this.#tokenHashesByUserCode.delete(entry.session.userCode);
        this.#notifyWaiters(entry.session.tokenHash, null, { includeSameStatus: true });
      },
    });
  }

  /** SHA-256 hex digest of the raw session token. Server only ever stores the hash. */
  static hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /**
   * Create a new pending session keyed by `tokenHash`.
   *
   * If `tokenHash` already exists, the previous session is replaced (idempotent
   * re-init from the same client). Reverse indexes for the old state/userCode
   * are cleaned up.
   */
  createSession(params: {
    tokenHash: string;
    provider: OAuthProviderName;
    pkceVerifier: string;
    state: string;
    clientType?: OAuthClientType;
  }): PendingAuthSession {
    const now = this.#now();
    const session: PendingAuthSessionRecord = {
      tokenHash: params.tokenHash,
      provider: params.provider,
      pkceVerifier: params.pkceVerifier,
      state: params.state,
      userCode: this.#generateUniqueUserCode(),
      status: PendingAuthStatus.Pending,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#sessionTtlMs),
      clientType: params.clientType,
    };

    this.#setSession(session);
    return this.#cloneSession(session);
  }

  /** Lookup by hashed session token. Returns null if missing or expired. */
  getSession(tokenHash: string): PendingAuthSession | null {
    return this.getSessionByTokenHash(tokenHash);
  }

  getSessionByTokenHash(tokenHash: string): PendingAuthSession | null {
    const entry = this.#getActiveEntry(tokenHash);
    return entry ? this.#cloneSession(entry.session) : null;
  }

  /** Lookup by the OAuth `state` parameter (used during provider callback). */
  getSessionByState(state: string): PendingAuthSession | null {
    const tokenHash = this.#tokenHashesByState.get(state);
    if (!tokenHash) {
      return null;
    }

    return this.getSessionByTokenHash(tokenHash);
  }

  /** Lookup by user-facing 4-char visual code. */
  getSessionByUserCode(userCode: string): PendingAuthSession | null {
    const tokenHash = this.#tokenHashesByUserCode.get(userCode);
    if (!tokenHash) {
      return null;
    }

    return this.getSessionByTokenHash(tokenHash);
  }

  /**
   * Transition to `awaiting_confirmation` without staging tokens. Test seam:
   * lets long-poll tests exercise the intermediate state without running the
   * full provider-callback path. Production code uses `stageCompletion`
   * instead, which also stages tokens for confirm.
   *
   * Subject to terminal-state guards: complete/consumed/denied/error are immutable.
   */
  markAwaitingConfirmation(tokenHash: string): PendingAuthSession | null {
    const entry = this.#getActiveEntry(tokenHash);
    if (!entry) {
      return null;
    }
    if (
      entry.session.status === PendingAuthStatus.Complete ||
      entry.session.status === PendingAuthStatus.Consumed ||
      entry.session.status === PendingAuthStatus.Denied ||
      entry.session.status === PendingAuthStatus.Error
    ) {
      return null;
    }
    return this.#updateSession({ tokenHash, status: PendingAuthStatus.AwaitingConfirmation });
  }

  /**
   * Stage tokens for an explicit confirm step. Transitions `pending → awaiting_confirmation`.
   * Caller MUST later call `confirmSession` or `denySession` to release.
   * Returns null if the session is missing, expired, or already in a terminal state.
   */
  stageCompletion(params: {
    tokenHash: string;
    tokens: PendingAuthTokens;
    user: UserProfile;
  }): PendingAuthSession | null {
    const entry = this.#getActiveEntry(params.tokenHash);
    if (!entry) {
      return null;
    }
    // Terminal-state guard: don't downgrade denied/error/complete/consumed sessions
    if (
      entry.session.status === PendingAuthStatus.Denied ||
      entry.session.status === PendingAuthStatus.Error ||
      entry.session.status === PendingAuthStatus.Complete ||
      entry.session.status === PendingAuthStatus.Consumed
    ) {
      return null;
    }

    return this.#updateSession({
      tokenHash: params.tokenHash,
      status: PendingAuthStatus.AwaitingConfirmation,
      stagedTokens: params.tokens,
      stagedUser: params.user,
      tokens: undefined,
      user: undefined,
      errorMessage: undefined,
    });
  }

  /**
   * Promote a staged session to `complete`. Only valid from `awaiting_confirmation`.
   * Returns null if the session is missing, expired, or not in the expected state.
   */
  confirmSession(tokenHash: string): PendingAuthSession | null {
    const entry = this.#getActiveEntry(tokenHash);
    if (!entry || entry.session.status !== PendingAuthStatus.AwaitingConfirmation) {
      return null;
    }

    const { stagedTokens, stagedUser } = entry.session;
    if (!stagedTokens || !stagedUser) {
      return null;
    }

    return this.#updateSession({
      tokenHash,
      status: PendingAuthStatus.Complete,
      tokens: stagedTokens,
      user: stagedUser,
      stagedTokens: undefined,
      stagedUser: undefined,
      errorMessage: undefined,
    });
  }

  /**
   * Directly transition a session to `complete` with tokens, skipping the
   * staged-confirmation step. Test seam: isolates the `/auth/session/status`
   * route logic from the full provider-callback flow. Production OAuth uses
   * `stageCompletion` → `confirmSession`. Honours terminal-state guards
   * (won't overwrite denied/error).
   */
  completeSession(params: {
    tokenHash: string;
    tokens: PendingAuthTokens;
    user: UserProfile;
  }): PendingAuthSession | null {
    const entry = this.#getActiveEntry(params.tokenHash);
    if (!entry) {
      return null;
    }
    if (entry.session.status === PendingAuthStatus.Denied || entry.session.status === PendingAuthStatus.Error) {
      return null;
    }
    return this.#updateSession({
      tokenHash: params.tokenHash,
      status: PendingAuthStatus.Complete,
      tokens: params.tokens,
      user: params.user,
      errorMessage: undefined,
    });
  }

  /**
   * Transition to `denied`. Terminal — subsequent confirm/stage attempts are
   * rejected (terminal-state guards in `stageCompletion`/`confirmSession`).
   */
  denySession(tokenHash: string): PendingAuthSession | null {
    const entry = this.#getActiveEntry(tokenHash);
    if (!entry) {
      return null;
    }
    // Terminal-state guard: complete/consumed/denied/error are all terminal.
    // Re-denying a denied session is a no-op; never overwrite a previously
    // recorded error with a generic deny.
    if (
      entry.session.status === PendingAuthStatus.Complete ||
      entry.session.status === PendingAuthStatus.Consumed ||
      entry.session.status === PendingAuthStatus.Denied ||
      entry.session.status === PendingAuthStatus.Error
    ) {
      return null;
    }
    return this.#updateSession({
      tokenHash,
      status: PendingAuthStatus.Denied,
      stagedTokens: undefined,
      stagedUser: undefined,
      tokens: undefined,
      user: undefined,
      errorMessage: undefined,
    });
  }

  /**
   * Transition to `error` (e.g. provider returned a non-`access_denied` error,
   * or the token exchange threw). Terminal.
   */
  failSession(params: { tokenHash: string; errorMessage: string }): PendingAuthSession | null {
    const entry = this.#getActiveEntry(params.tokenHash);
    if (!entry) {
      return null;
    }
    // Terminal-state guard: never overwrite an already-terminal state. A late
    // OAuth-exchange error must not clobber a deny that the user already
    // submitted, and obviously must not clobber a successful complete.
    if (
      entry.session.status === PendingAuthStatus.Complete ||
      entry.session.status === PendingAuthStatus.Consumed ||
      entry.session.status === PendingAuthStatus.Denied ||
      entry.session.status === PendingAuthStatus.Error
    ) {
      return null;
    }
    return this.#updateSession({
      tokenHash: params.tokenHash,
      status: PendingAuthStatus.Error,
      stagedTokens: undefined,
      stagedUser: undefined,
      tokens: undefined,
      user: undefined,
      errorMessage: params.errorMessage,
    });
  }

  /**
   * Atomically consume a completed session — returns tokens/user once, then
   * deletes the entry. Subsequent calls return null (the LRU entry is gone,
   * `getSessionByTokenHash` returns null too).
   */
  consumeCompletion(tokenHash: string): { tokens: PendingAuthTokens; user: UserProfile } | null {
    const entry = this.#getActiveEntry(tokenHash);
    if (!entry || entry.session.status !== PendingAuthStatus.Complete || !entry.session.tokens || !entry.session.user) {
      return null;
    }

    const completion = {
      tokens: { ...entry.session.tokens },
      user: { ...entry.session.user },
    };

    // Notify any pollers with a "consumed" status, then delete the entry.
    // The LRU dispose callback also notifies (with null), but the waiters set
    // is already emptied by this first notification so it's a no-op safeguard.
    const consumedSession: PendingAuthSessionRecord = {
      ...entry.session,
      status: PendingAuthStatus.Consumed,
      stagedTokens: undefined,
      stagedUser: undefined,
      tokens: undefined,
      user: undefined,
      errorMessage: undefined,
    };
    this.#notifyWaiters(tokenHash, consumedSession, { includeSameStatus: true });
    this.#sessions.delete(tokenHash);

    return completion;
  }

  /**
   * Wait for the session's status to change away from its current value, or
   * for `timeoutMs` to elapse. Returns the latest session snapshot at the
   * moment of resolution (or null if the session was deleted).
   *
   * Race-safe: a status change happening between `getSessionByTokenHash` and
   * waiter registration triggers an immediate resolve via the re-check below.
   */
  waitForStatusChange(
    tokenHash: string,
    timeoutMs: number,
    options?: { abortSignal?: AbortSignal },
  ): Promise<PendingAuthSession | null> {
    const session = this.getSessionByTokenHash(tokenHash);
    if (!session) {
      return Promise.resolve(null);
    }

    if (options?.abortSignal?.aborted) {
      return Promise.resolve(null);
    }

    if (timeoutMs <= 0) {
      return Promise.resolve(session);
    }

    // Cap the wait at the session's remaining TTL so long-pollers receive the
    // `expired` transition promptly (per-poll timer, NOT per-entry — there's
    // at most O(active pollers) timers, which is bounded by FD count).
    const msUntilExpiry = Math.max(0, session.expiresAt.getTime() - this.#now().getTime());
    const expiryTimeoutMs = msUntilExpiry + 1;
    const effectiveTimeoutMs = Math.min(timeoutMs, expiryTimeoutMs);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#removeWaiter(tokenHash, waiter);
        const expiringEntry = this.#sessions.get(tokenHash);
        if (expiringEntry && expiringEntry.session.expiresAt.getTime() <= this.#now().getTime()) {
          this.#expireSession(tokenHash, expiringEntry);
          resolve({ ...this.#cloneSession(expiringEntry.session), status: PendingAuthStatus.Expired });
          return;
        }
        resolve(this.getSessionByTokenHash(tokenHash));
      }, effectiveTimeoutMs);
      timeout.unref?.();

      const waiter: StatusWaiter = {
        initialStatus: session.status,
        resolve: (nextSession) => {
          clearTimeout(timeout);
          if (waiter.abortSignal && waiter.abortListener) {
            waiter.abortSignal.removeEventListener("abort", waiter.abortListener);
          }
          resolve(nextSession);
        },
        timeout,
        abortSignal: options?.abortSignal,
      };

      if (options?.abortSignal) {
        // Recheck inside the promise executor: the signal may have aborted in
        // the gap between the initial check above and listener registration.
        if (options.abortSignal.aborted) {
          clearTimeout(timeout);
          resolve(null);
          return;
        }
        waiter.abortListener = () => {
          this.#removeWaiter(tokenHash, waiter);
          clearTimeout(timeout);
          resolve(null);
        };
        options.abortSignal.addEventListener("abort", waiter.abortListener, { once: true });
      }

      const waiters = this.#waitersByTokenHash.get(tokenHash) ?? new Set<StatusWaiter>();
      waiters.add(waiter);
      this.#waitersByTokenHash.set(tokenHash, waiters);

      // Re-check after registration: if status changed between snapshot and
      // waiter add, resolve immediately. Without this, a transition that
      // happens in the gap would be missed and the caller would block until
      // the timeout fires.
      const latestSession = this.getSessionByTokenHash(tokenHash);
      if (!latestSession || latestSession.status !== waiter.initialStatus) {
        this.#removeWaiter(tokenHash, waiter);
        waiter.resolve(latestSession);
      }
    });
  }

  /**
   * Sweep expired entries proactively. Optional — `#getActiveEntry` already
   * expires on read. Useful only when callers want waiters to be notified
   * promptly on TTL elapse without a corresponding read.
   */
  expireExpiredSessions(now = this.#now()): void {
    for (const [tokenHash, entry] of this.#sessions.entries()) {
      if (entry.session.expiresAt.getTime() <= now.getTime()) {
        this.#expireSession(tokenHash, entry);
      }
    }
  }

  #updateSession(params: {
    tokenHash: string;
    status: PendingAuthStatus;
    stagedTokens?: PendingAuthTokens;
    stagedUser?: UserProfile;
    tokens?: PendingAuthTokens;
    user?: UserProfile;
    errorMessage?: string;
  }): PendingAuthSession | null {
    const entry = this.#getActiveEntry(params.tokenHash);
    if (!entry) {
      return null;
    }

    entry.session.status = params.status;
    entry.session.stagedTokens = params.stagedTokens ? { ...params.stagedTokens } : params.stagedTokens;
    entry.session.stagedUser = params.stagedUser ? { ...params.stagedUser } : params.stagedUser;
    entry.session.tokens = params.tokens ? { ...params.tokens } : params.tokens;
    entry.session.user = params.user ? { ...params.user } : params.user;
    entry.session.errorMessage = params.errorMessage;
    this.#notifyWaiters(params.tokenHash, entry.session);

    return this.#cloneSession(entry.session);
  }

  #getActiveEntry(tokenHash: string): PendingAuthStoreEntry | null {
    const entry = this.#sessions.get(tokenHash);
    if (!entry) {
      return null;
    }

    if (entry.session.expiresAt.getTime() <= this.#now().getTime()) {
      this.#expireSession(tokenHash, entry);
      return null;
    }

    return entry;
  }

  #setSession(session: PendingAuthSessionRecord): void {
    const existingEntry = this.#sessions.get(session.tokenHash);
    if (existingEntry) {
      if (existingEntry.session.state !== session.state) {
        this.#tokenHashesByState.delete(existingEntry.session.state);
      }
      if (existingEntry.session.userCode !== session.userCode) {
        this.#tokenHashesByUserCode.delete(existingEntry.session.userCode);
      }
    }

    this.#tokenHashesByState.set(session.state, session.tokenHash);
    this.#tokenHashesByUserCode.set(session.userCode, session.tokenHash);
    this.#sessions.set(session.tokenHash, { session });
  }

  #expireSession(tokenHash: string, entry: PendingAuthStoreEntry): void {
    const expiredSession: PendingAuthSessionRecord = {
      ...entry.session,
      status: PendingAuthStatus.Expired,
      stagedTokens: undefined,
      stagedUser: undefined,
      tokens: undefined,
      user: undefined,
      errorMessage: undefined,
    };

    this.#notifyWaiters(tokenHash, expiredSession, { includeSameStatus: true });
    this.#sessions.delete(tokenHash);
  }

  #notifyWaiters(
    tokenHash: string,
    session: PendingAuthSessionRecord | null,
    options?: { includeSameStatus?: boolean },
  ): void {
    const waiters = this.#waitersByTokenHash.get(tokenHash);
    if (!waiters) {
      return;
    }

    const nextSession = session ? this.#cloneSession(session) : null;
    // Snapshot before mutating — defends against future refactors that might
    // confuse the iteration order of `Set.delete()` mid-loop.
    const snapshot = Array.from(waiters);
    for (const waiter of snapshot) {
      if (!options?.includeSameStatus && nextSession && waiter.initialStatus === nextSession.status) {
        continue;
      }

      waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(nextSession);
    }

    if (waiters.size === 0) {
      this.#waitersByTokenHash.delete(tokenHash);
    }
  }

  #removeWaiter(tokenHash: string, waiter: StatusWaiter): void {
    const waiters = this.#waitersByTokenHash.get(tokenHash);
    if (!waiters) {
      return;
    }

    waiters.delete(waiter);
    if (waiter.abortSignal && waiter.abortListener) {
      waiter.abortSignal.removeEventListener("abort", waiter.abortListener);
    }
    if (waiters.size === 0) {
      this.#waitersByTokenHash.delete(tokenHash);
    }
  }

  #generateUniqueUserCode(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const userCode = this.#userCodeGenerator().toUpperCase();
      if (userCode.length !== USER_CODE_LENGTH || !USER_CODE_REGEX.test(userCode)) {
        throw new Error("PendingAuthStore userCodeGenerator must return a 4-character alphanumeric code");
      }

      if (!this.#tokenHashesByUserCode.has(userCode)) {
        return userCode;
      }
    }

    throw new Error("Unable to generate a unique pending auth user code");
  }

  #createUserCode(): string {
    let userCode = "";
    while (userCode.length < USER_CODE_LENGTH) {
      userCode += USER_CODE_ALPHABET[crypto.randomInt(0, USER_CODE_ALPHABET.length)];
    }

    return userCode;
  }

  #cloneSession(session: PendingAuthSessionRecord): PendingAuthSession {
    return {
      tokenHash: session.tokenHash,
      provider: session.provider,
      pkceVerifier: session.pkceVerifier,
      state: session.state,
      userCode: session.userCode,
      status: session.status,
      createdAt: new Date(session.createdAt),
      expiresAt: new Date(session.expiresAt),
      tokens: session.tokens ? { ...session.tokens } : undefined,
      user: session.user ? { ...session.user } : undefined,
      errorMessage: session.errorMessage,
      clientType: session.clientType,
    };
  }
}

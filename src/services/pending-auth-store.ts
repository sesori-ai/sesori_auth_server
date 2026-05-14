import * as crypto from "node:crypto";
import { LRUCache } from "lru-cache";
import type { UserProfile } from "../models/api.js";
import { OAuthProviderName } from "../types/oauth.js";

const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 10_000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 4;

export type PendingAuthStatus =
  | "pending"
  | "awaiting_confirmation"
  | "complete"
  | "consumed"
  | "denied"
  | "expired"
  | "error";

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
  tokens?: PendingAuthTokens;
  user?: UserProfile;
  errorMessage?: string;
};

type PendingAuthStoreEntry = {
  session: PendingAuthSessionRecord;
  expiryTimer: ReturnType<typeof setTimeout>;
};

type PendingAuthSessionRecord = PendingAuthSession & {
  stagedTokens?: PendingAuthTokens;
  stagedUser?: UserProfile;
};

type StatusWaiter = {
  initialStatus: PendingAuthStatus;
  resolve: (session: PendingAuthSession | null) => void;
  timeout: ReturnType<typeof setTimeout>;
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
        clearTimeout(entry.expiryTimer);
        this.#tokenHashesByState.delete(entry.session.state);
        this.#tokenHashesByUserCode.delete(entry.session.userCode);
        this.#notifyWaiters(entry.session.tokenHash, null, { includeSameStatus: true });
      },
    });
  }

  static hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  createSession(params: {
    tokenHash: string;
    provider: OAuthProviderName;
    pkceVerifier: string;
    state: string;
  }): PendingAuthSession {
    const now = this.#now();
    const session: PendingAuthSessionRecord = {
      tokenHash: params.tokenHash,
      provider: params.provider,
      pkceVerifier: params.pkceVerifier,
      state: params.state,
      userCode: this.#generateUniqueUserCode(),
      status: "pending",
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#sessionTtlMs),
    };

    this.#setSession(session);
    return this.#cloneSession(session);
  }

  getSession(tokenHash: string): PendingAuthSession | null {
    return this.getSessionByTokenHash(tokenHash);
  }

  getSessionByTokenHash(tokenHash: string): PendingAuthSession | null {
    const entry = this.#getActiveEntry(tokenHash);
    return entry ? this.#cloneSession(entry.session) : null;
  }

  getSessionByState(state: string): PendingAuthSession | null {
    const tokenHash = this.#tokenHashesByState.get(state);
    if (!tokenHash) {
      return null;
    }

    return this.getSessionByTokenHash(tokenHash);
  }

  getSessionByUserCode(userCode: string): PendingAuthSession | null {
    const tokenHash = this.#tokenHashesByUserCode.get(userCode);
    if (!tokenHash) {
      return null;
    }

    return this.getSessionByTokenHash(tokenHash);
  }

  markAwaitingConfirmation(tokenHash: string): PendingAuthSession | null {
    return this.#updateSession({ tokenHash, status: "awaiting_confirmation" });
  }

  stageCompletion(params: {
    tokenHash: string;
    tokens: PendingAuthTokens;
    user: UserProfile;
  }): PendingAuthSession | null {
    return this.#updateSession({
      tokenHash: params.tokenHash,
      status: "awaiting_confirmation",
      stagedTokens: params.tokens,
      stagedUser: params.user,
      tokens: undefined,
      user: undefined,
      errorMessage: undefined,
    });
  }

  confirmSession(tokenHash: string): PendingAuthSession | null {
    const entry = this.#getActiveEntry(tokenHash);
    if (!entry || entry.session.status !== "awaiting_confirmation") {
      return null;
    }

    const session = entry.session as PendingAuthSessionRecord;
    if (!session.stagedTokens || !session.stagedUser) {
      return null;
    }

    return this.#updateSession({
      tokenHash,
      status: "complete",
      tokens: session.stagedTokens,
      user: session.stagedUser,
      stagedTokens: undefined,
      stagedUser: undefined,
      errorMessage: undefined,
    });
  }

  completeSession(params: {
    tokenHash: string;
    tokens: PendingAuthTokens;
    user: UserProfile;
  }): PendingAuthSession | null {
    return this.#updateSession({
      tokenHash: params.tokenHash,
      status: "complete",
      tokens: params.tokens,
      user: params.user,
      errorMessage: undefined,
    });
  }

  denySession(tokenHash: string): PendingAuthSession | null {
    return this.#updateSession({
      tokenHash,
      status: "denied",
      stagedTokens: undefined,
      stagedUser: undefined,
      tokens: undefined,
      user: undefined,
      errorMessage: undefined,
    });
  }

  failSession(params: { tokenHash: string; errorMessage: string }): PendingAuthSession | null {
    return this.#updateSession({
      tokenHash: params.tokenHash,
      status: "error",
      stagedTokens: undefined,
      stagedUser: undefined,
      tokens: undefined,
      user: undefined,
      errorMessage: params.errorMessage,
    });
  }

  updateSession(
    tokenHash: string,
    update: {
      status: PendingAuthStatus;
      stagedTokens?: PendingAuthTokens;
      stagedUser?: UserProfile;
      tokens?: PendingAuthTokens;
      user?: UserProfile;
      errorMessage?: string;
    },
  ): PendingAuthSession | null {
    return this.#updateSession({
      tokenHash,
      status: update.status,
      stagedTokens: update.stagedTokens,
      stagedUser: update.stagedUser,
      tokens: update.tokens,
      user: update.user,
      errorMessage: update.errorMessage,
    });
  }

  consumeCompletion(tokenHash: string): { tokens: PendingAuthTokens; user: UserProfile } | null {
    const entry = this.#getActiveEntry(tokenHash);
    if (!entry || entry.session.status !== "complete" || !entry.session.tokens || !entry.session.user) {
      return null;
    }

    const completion = {
      tokens: { ...entry.session.tokens },
      user: { ...entry.session.user },
    };

    const consumedSession: PendingAuthSessionRecord = {
      ...entry.session,
      status: "consumed",
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

  consumeCompletedSession(tokenHash: string): PendingAuthSession | null {
    const entry = this.#getActiveEntry(tokenHash);
    if (!entry || entry.session.status !== "complete" || !entry.session.tokens || !entry.session.user) {
      return null;
    }

    const consumedSession: PendingAuthSessionRecord = {
      ...entry.session,
      status: "consumed",
      stagedTokens: undefined,
      stagedUser: undefined,
      tokens: undefined,
      user: undefined,
      errorMessage: undefined,
    };

    this.consumeCompletion(tokenHash);
    return this.#cloneSession(consumedSession);
  }

  waitForStatusChange(tokenHash: string, timeoutMs: number): Promise<PendingAuthSession | null> {
    const session = this.getSessionByTokenHash(tokenHash);
    if (!session) {
      return Promise.resolve(null);
    }

    if (timeoutMs <= 0) {
      return Promise.resolve(session);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#removeWaiter(tokenHash, waiter);
        resolve(this.getSessionByTokenHash(tokenHash));
      }, timeoutMs);
      timeout.unref?.();

      const waiter: StatusWaiter = {
        initialStatus: session.status,
        resolve: (nextSession) => {
          clearTimeout(timeout);
          resolve(nextSession);
        },
        timeout,
      };

      const waiters = this.#waitersByTokenHash.get(tokenHash) ?? new Set<StatusWaiter>();
      waiters.add(waiter);
      this.#waitersByTokenHash.set(tokenHash, waiters);

      const latestSession = this.getSessionByTokenHash(tokenHash);
      if (!latestSession || latestSession.status !== waiter.initialStatus) {
        this.#removeWaiter(tokenHash, waiter);
        waiter.resolve(latestSession);
      }
    });
  }

  expireExpiredSessions(now = this.#now()): void {
    for (const [tokenHash, entry] of this.#sessions.entries()) {
      if (entry.session.expiresAt.getTime() <= now.getTime()) {
        this.#expireSession(tokenHash, entry);
      }
    }
  }

  deleteSession(tokenHash: string): boolean {
    return this.#sessions.delete(tokenHash);
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
      clearTimeout(existingEntry.expiryTimer);
      if (existingEntry.session.state !== session.state) {
        this.#tokenHashesByState.delete(existingEntry.session.state);
      }
      if (existingEntry.session.userCode !== session.userCode) {
        this.#tokenHashesByUserCode.delete(existingEntry.session.userCode);
      }
    }

    this.#tokenHashesByState.set(session.state, session.tokenHash);
    this.#tokenHashesByUserCode.set(session.userCode, session.tokenHash);
    this.#sessions.set(session.tokenHash, {
      session,
      expiryTimer: (() => {
        const timer = setTimeout(
          () => {
            const entry = this.#sessions.get(session.tokenHash);
            if (entry) {
              this.#expireSession(session.tokenHash, entry);
            }
          },
          Math.max(0, session.expiresAt.getTime() - this.#now().getTime()),
        );
        timer.unref?.();
        return timer;
      })(),
    });
  }

  #expireSession(tokenHash: string, entry: PendingAuthStoreEntry): void {
    clearTimeout(entry.expiryTimer);

    const expiredSession: PendingAuthSessionRecord = {
      ...entry.session,
      status: "expired",
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
    for (const waiter of waiters) {
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
    if (waiters.size === 0) {
      this.#waitersByTokenHash.delete(tokenHash);
    }
  }

  #generateUniqueUserCode(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const userCode = this.#userCodeGenerator().toUpperCase();
      if (userCode.length !== USER_CODE_LENGTH || !/^[A-Z0-9]{4}$/.test(userCode)) {
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
    };
  }
}

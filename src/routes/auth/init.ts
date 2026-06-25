/**
 * Shared helpers for the OAuth pending-session init endpoints.
 *
 * The `X-Sesori-Session-Token` header is a client-generated random 64-char
 * hex string. The client retains the raw value; the server stores only
 * `sha256(token)` after canonicalizing the input to lowercase, so case
 * mismatches between init and status polls cannot misroute the digest.
 * The same token is used to long-poll `/auth/session/status` until tokens
 * are delivered or the session terminates (denied / expired / error).
 * Single-use per OAuth attempt — a second init with the same token replaces
 * any prior pending session for that token.
 *
 * `clientType` is validated against `OAuthClientType` (TS enum, wire values
 * like `"bridge_macos"`) and recorded on the pending session for
 * audit/observability. It is NOT used for any security decision today.
 */

import crypto from "node:crypto";
import { BadRequestError } from "../../lib/errors.js";
import {
  OAuthClientType,
  oauthPendingInitBodySchema,
  type DeviceInfo,
  type OAuthPendingInitBody,
  type OAuthPendingInitReply,
} from "../../models/api.js";
import { PendingAuthStore, type PendingAuthSession } from "../../services/pending-auth-store.js";
import { OAuthProviderName } from "../../types/oauth.js";

const SESSION_TOKEN_HEADER = "x-sesori-session-token";
const SESSION_TOKEN_REGEX = /^[a-f0-9]{64}$/i;
const STATE_BYTE_LENGTH = 32;
const PKCE_VERIFIER_BYTE_LENGTH = 64;

/** Parses and validates the init request body. Throws `BadRequestError` on failure. */
export function parseOAuthPendingInitBody(body: unknown): OAuthPendingInitBody {
  const result = oauthPendingInitBodySchema.safeParse(body);
  if (!result.success) {
    throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: result.error.issues });
  }

  return result.data;
}

/**
 * Parses and validates the session token header. Canonicalizes to lowercase
 * so that callers re-sending the same token with different casing
 * (`ABCDEF…` vs `abcdef…`) hash to the same digest. Throws `BadRequestError`
 * on missing/invalid input.
 */
export function parseSessionTokenHeader(value: string | string[] | undefined): string {
  const token = Array.isArray(value) ? value[0] : value;
  if (!token || !SESSION_TOKEN_REGEX.test(token)) {
    throw new BadRequestError({ debugMessage: `Missing or invalid ${SESSION_TOKEN_HEADER} header` });
  }

  return token.toLowerCase();
}

/**
 * Generates a fresh PKCE verifier + state and creates a pending session keyed
 * by the hashed session token. Returns the session record and the code
 * challenge (SHA-256 of the verifier, base64url-encoded).
 */
export function createPendingOAuthInit(params: {
  provider: OAuthProviderName;
  pendingAuthStore: PendingAuthStore;
  sessionToken: string;
  clientType?: OAuthClientType;
  device?: DeviceInfo;
}): { session: PendingAuthSession; codeChallenge: string } {
  const pkceVerifier = crypto.randomBytes(PKCE_VERIFIER_BYTE_LENGTH).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(pkceVerifier).digest("base64url");
  const state = crypto.randomBytes(STATE_BYTE_LENGTH).toString("hex");

  const session = params.pendingAuthStore.createSession({
    tokenHash: PendingAuthStore.hashToken(params.sessionToken),
    provider: params.provider,
    pkceVerifier,
    state,
    clientType: params.clientType,
    device: params.device,
  });

  return { session, codeChallenge };
}

/** Builds the response body for `/auth/{provider}/init` from a pending session record. */
export function createOAuthPendingInitReply(params: {
  session: PendingAuthSession;
  authUrl: URL;
}): OAuthPendingInitReply {
  return {
    authUrl: params.authUrl.toString(),
    state: params.session.state,
    userCode: params.session.userCode,
    expiresIn: Math.max(0, Math.ceil((params.session.expiresAt.getTime() - Date.now()) / 1000)),
  };
}

/**
 * Builds the backend callback URL for a given provider, derived from
 * `AUTH_BASE_URL`. Preserves any base-path prefix present on the configured
 * URL (e.g. `https://example.com/authsvc` → `…/authsvc/auth/github/callback`)
 * by appending the provider segment instead of overwriting `pathname`.
 */
export function getProviderCallbackRedirectUri(baseUrl: string, provider: OAuthProviderName): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  switch (provider) {
    case OAuthProviderName.Github:
      url.pathname = `${basePath}/auth/github/callback`;
      break;
    case OAuthProviderName.Google:
      url.pathname = `${basePath}/auth/google/callback`;
      break;
    case OAuthProviderName.Apple:
      url.pathname = `${basePath}/auth/apple/callback`;
      break;
  }
  return url.toString();
}

import * as crypto from "node:crypto";
import { BadRequestError } from "../../lib/errors.js";
import { oauthPendingInitBodySchema, type OAuthPendingInitBody, type OAuthPendingInitReply } from "../../models/api.js";
import { PendingAuthStore, type PendingAuthSession } from "../../services/pending-auth-store.js";
import { OAuthProviderName } from "../../types/oauth.js";

const SESSION_TOKEN_HEADER = "x-sesori-session-token";
const SESSION_TOKEN_REGEX = /^[a-f0-9]{64}$/i;
const STATE_BYTE_LENGTH = 32;
const PKCE_VERIFIER_BYTE_LENGTH = 64;

export function parseOAuthPendingInitBody(body: unknown): OAuthPendingInitBody {
  const result = oauthPendingInitBodySchema.safeParse(body);
  if (!result.success) {
    throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: result.error.issues });
  }

  return result.data;
}

export function parseSessionTokenHeader(value: string | string[] | undefined): string {
  const token = Array.isArray(value) ? value[0] : value;
  if (!token || !SESSION_TOKEN_REGEX.test(token)) {
    throw new BadRequestError({ debugMessage: `Missing or invalid ${SESSION_TOKEN_HEADER} header` });
  }

  return token;
}

export function createPendingOAuthInit(params: {
  provider: OAuthProviderName;
  pendingAuthStore: PendingAuthStore;
  sessionToken: string;
}): { session: PendingAuthSession; codeChallenge: string } {
  const pkceVerifier = crypto.randomBytes(PKCE_VERIFIER_BYTE_LENGTH).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(pkceVerifier).digest("base64url");
  const state = crypto.randomBytes(STATE_BYTE_LENGTH).toString("hex");

  const session = params.pendingAuthStore.createSession({
    tokenHash: PendingAuthStore.hashToken(params.sessionToken),
    provider: params.provider,
    pkceVerifier,
    state,
  });

  return { session, codeChallenge };
}

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

export function getProviderCallbackRedirectUri(provider: OAuthProviderName): string {
  switch (provider) {
    case OAuthProviderName.Github:
      return "https://api.sesori.com/auth/github/callback";
    case OAuthProviderName.Google:
      return "https://api.sesori.com/auth/google/callback";
    case OAuthProviderName.Apple:
      return "https://api.sesori.com/auth/apple/callback";
  }
}

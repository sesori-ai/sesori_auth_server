/**
 * Anti-phishing OAuth confirmation interstitial.
 *
 * The provider redirects the user back to `/auth/{provider}/callback` with
 * `code` and `state`. Rather than exchanging the code and immediately issuing
 * tokens to whoever triggered the callback (vulnerable to phishing redirects
 * that trick the user into completing sign-in for an attacker-controlled
 * session token), we render a confirmation page describing the device that
 * started the sign-in. Tokens are issued only after the user explicitly
 * confirms in-browser.
 *
 * The page shows the requesting device's type + OS (derived from the
 * enum-bounded `clientType` captured at init) and, when the client supplied
 * one, a human-readable device name. The device name is UNTRUSTED
 * client-supplied text (recognition aid only, HTML-escaped here); the
 * trustworthy signal is `clientType`.
 *
 * Two handlers are exported:
 *  - `handleProviderCallbackRedirect`: GET handler invoked by the OAuth
 *    provider after user consent. Validates state, exchanges code for tokens
 *    via `AuthService`, stages tokens on the pending session, and renders the
 *    confirmation HTML.
 *  - `handleProviderCallbackAction`: POST handler invoked when the user
 *    submits the confirmation HTML <form> (confirm / deny). Promotes the
 *    staged session to `complete` (or transitions to `denied`).
 *
 * Untrusted inputs handled here:
 *  - `state` and `error_description` come from the OAuth provider URL. State
 *    is regex-validated; error_description is HTML-escaped before reflection.
 *  - Form body for confirm/deny is Zod-parsed (`callbackActionBodySchema`).
 *  - Provider names are interpolated as URL path segments via
 *    `encodeURIComponent` (defense in depth — they are enum-bounded today).
 */

import { z } from "zod";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { OAuthClient } from "../../clients/auth/oauth-client.js";
import { OAuthClientType } from "../../models/api.js";
import type { AuthService } from "../../services/auth-service.js";
import {
  PendingAuthStatus,
  type PendingAuthSession,
  type PendingAuthStore,
} from "../../services/pending-auth-store.js";
import { OAuthProviderName } from "../../types/oauth.js";

const pendingStateSchema = z.string().regex(/^[a-f0-9]{64}$/i, "Invalid pending auth state");

const oauthCallbackQuerySchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1),
    error: z.string().min(1).optional(),
    error_description: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (!value.code && !value.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["code"],
        message: "OAuth callback requires either code or error",
      });
    }
  });

const callbackActionBodySchema = z.object({
  state: z.string().min(1),
  action: z.enum(["confirm", "deny"]),
});

const MAX_REFLECTED_ERROR_LENGTH = 200;

type ProviderCallbackDeps<TClient extends OAuthClient> = {
  providerName: OAuthProviderName;
  providerClient: TClient;
  authService: AuthService;
  pendingAuthStore: PendingAuthStore;
  clientId: string;
  clientSecret?: string;
  callbackRedirectUri: string;
};

export async function handleProviderCallbackRedirect<TClient extends OAuthClient>(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  deps: ProviderCallbackDeps<TClient>;
}): Promise<FastifyReply> {
  const queryResult = oauthCallbackQuerySchema.safeParse(params.request.query);
  if (!queryResult.success) {
    return sendErrorPage({
      reply: params.reply,
      statusCode: 400,
      title: "Invalid sign-in callback",
      message: "The provider callback was missing required information.",
    });
  }

  const stateResult = pendingStateSchema.safeParse(queryResult.data.state);
  if (!stateResult.success) {
    return sendErrorPage({
      reply: params.reply,
      statusCode: 400,
      title: "Invalid sign-in callback",
      message: "The sign-in request state was invalid.",
    });
  }

  const session = params.deps.pendingAuthStore.getSessionByState(stateResult.data);
  if (!session || session.provider !== params.deps.providerName) {
    return sendErrorPage({
      reply: params.reply,
      statusCode: 410,
      title: "Sign-in request expired",
      message: "This sign-in request has expired or is no longer available. Please start again from Sesori.",
    });
  }

  if (queryResult.data.error) {
    return await handleProviderErrorCallback({
      reply: params.reply,
      pendingAuthStore: params.deps.pendingAuthStore,
      session,
      error: queryResult.data.error,
      errorDescription: queryResult.data.error_description,
    });
  }

  switch (session.status) {
    case PendingAuthStatus.AwaitingConfirmation:
      return sendConfirmationPage({ reply: params.reply, providerName: params.deps.providerName, session });
    case PendingAuthStatus.Complete:
    case PendingAuthStatus.Consumed:
      return sendSuccessPage({
        reply: params.reply,
        title: "Sign-in already confirmed",
        message: "This sign-in request has already been confirmed in Sesori.",
      });
    case PendingAuthStatus.Denied:
      return sendDeniedPage({
        reply: params.reply,
        title: "Sign-in cancelled",
        message: "This sign-in request was cancelled. Return to Sesori to start again.",
      });
    case PendingAuthStatus.Expired:
      return sendErrorPage({
        reply: params.reply,
        statusCode: 410,
        title: "Sign-in request expired",
        message: "This sign-in request has expired. Please start again from Sesori.",
      });
    case PendingAuthStatus.Error:
      return sendErrorPage({
        reply: params.reply,
        statusCode: 400,
        title: "Sign-in failed",
        message: session.errorMessage ?? "This sign-in request could not be completed.",
      });
    case PendingAuthStatus.Pending:
      break;
  }

  // `code` is guaranteed non-empty here: the `superRefine` rule rejects the
  // request when both `code` and `error` are missing, and the `error` branch
  // above returned. Narrow explicitly to avoid a non-null assertion.
  const code = queryResult.data.code;
  if (!code) {
    return sendErrorPage({
      reply: params.reply,
      statusCode: 400,
      title: "Invalid sign-in callback",
      message: "The provider callback was missing the authorization code.",
    });
  }

  try {
    const result = await params.deps.authService.authenticateOAuth(
      params.deps.providerName,
      params.deps.providerClient,
      {
        code,
        codeVerifier: session.pkceVerifier,
        redirectUri: params.deps.callbackRedirectUri,
        clientId: params.deps.clientId,
        clientSecret: params.deps.clientSecret,
      },
    );

    const stagedSession = params.deps.pendingAuthStore.stageCompletion({
      tokenHash: session.tokenHash,
      tokens: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
      user: result.user,
    });

    if (!stagedSession) {
      return sendErrorPage({
        reply: params.reply,
        statusCode: 410,
        title: "Sign-in request expired",
        message: "This sign-in request expired before it could be confirmed. Please start again from Sesori.",
      });
    }

    return sendConfirmationPage({
      reply: params.reply,
      providerName: params.deps.providerName,
      session: stagedSession,
    });
  } catch (err) {
    params.request.log.warn(
      { err, provider: params.deps.providerName, tokenHash: session.tokenHash },
      "oauth_exchange_failed",
    );
    params.deps.pendingAuthStore.failSession({
      tokenHash: session.tokenHash,
      errorMessage: "oauth_exchange_failed",
    });
    return sendErrorPage({
      reply: params.reply,
      statusCode: 502,
      title: "Sign-in failed",
      message: "Sesori could not finish the provider sign-in. Please return to the app and try again.",
    });
  }
}

async function handleProviderErrorCallback(params: {
  reply: FastifyReply;
  pendingAuthStore: PendingAuthStore;
  session: PendingAuthSession;
  error: string;
  errorDescription?: string;
}): Promise<FastifyReply> {
  if (params.session.status === PendingAuthStatus.Complete || params.session.status === PendingAuthStatus.Consumed) {
    return sendSuccessPage({
      reply: params.reply,
      title: "Sign-in already confirmed",
      message: "This sign-in request has already been confirmed in Sesori.",
    });
  }

  if (params.error === "access_denied") {
    params.pendingAuthStore.denySession(params.session.tokenHash);
    return sendDeniedPage({
      reply: params.reply,
      title: "Sign-in cancelled",
      message: "You cancelled this sign-in request. You can return to Sesori and try again.",
    });
  }

  // `errorDescription` originates from the OAuth provider's redirect URL and
  // is INTENTIONALLY surfaced to the end user (for debuggability). It is
  // HTML-escaped before rendering and truncated to bound page size.
  const safeMessage = truncateForDisplay(params.errorDescription ?? params.error, MAX_REFLECTED_ERROR_LENGTH);
  params.pendingAuthStore.failSession({
    tokenHash: params.session.tokenHash,
    errorMessage: safeMessage,
  });
  return sendErrorPage({
    reply: params.reply,
    statusCode: 400,
    title: "Sign-in failed",
    message: safeMessage,
  });
}

export async function handleProviderCallbackAction(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  pendingAuthStore: PendingAuthStore;
}): Promise<FastifyReply> {
  // Body-only parse: this route is POST and any state-changing query params
  // would be a security smell. The Fastify form-body parser is scoped to this
  // route so the body shape is `Record<string, unknown>` from URL-encoded
  // submissions, or a JSON object from `Content-Type: application/json`.
  const body = typeof params.request.body === "object" && params.request.body !== null ? params.request.body : {};
  const bodyResult = callbackActionBodySchema.safeParse(body);
  if (!bodyResult.success) {
    return sendErrorPage({
      reply: params.reply,
      statusCode: 400,
      title: "Invalid confirmation request",
      message: "The confirmation action was missing required information.",
    });
  }

  const stateResult = pendingStateSchema.safeParse(bodyResult.data.state);
  if (!stateResult.success) {
    return sendErrorPage({
      reply: params.reply,
      statusCode: 400,
      title: "Invalid confirmation request",
      message: "The sign-in request state was invalid.",
    });
  }

  const session = params.pendingAuthStore.getSessionByState(stateResult.data);
  if (!session) {
    return sendErrorPage({
      reply: params.reply,
      statusCode: 410,
      title: "Sign-in request expired",
      message: "This sign-in request has expired or is no longer available. Please start again from Sesori.",
    });
  }

  if (bodyResult.data.action === "deny") {
    if (session.status === PendingAuthStatus.Complete || session.status === PendingAuthStatus.Consumed) {
      return sendSuccessPage({
        reply: params.reply,
        title: "Sign-in already confirmed",
        message: "This sign-in request has already been confirmed in Sesori.",
      });
    }
    params.pendingAuthStore.denySession(session.tokenHash);
    return sendDeniedPage({
      reply: params.reply,
      title: "Sign-in cancelled",
      message: "This sign-in request was cancelled. Return to Sesori and try again when you're ready.",
    });
  }

  if (session.status === PendingAuthStatus.Complete || session.status === PendingAuthStatus.Consumed) {
    return sendSuccessPage({
      reply: params.reply,
      title: "Sign-in already confirmed",
      message: "This sign-in request has already been confirmed in Sesori.",
    });
  }

  if (session.status === PendingAuthStatus.Denied) {
    return sendDeniedPage({
      reply: params.reply,
      title: "Sign-in cancelled",
      message: "This sign-in request was already cancelled.",
    });
  }

  if (session.status === PendingAuthStatus.Error) {
    return sendErrorPage({
      reply: params.reply,
      statusCode: 400,
      title: "Sign-in failed",
      message: session.errorMessage ?? "This sign-in request could not be completed.",
    });
  }

  const completedSession = params.pendingAuthStore.confirmSession(session.tokenHash);
  if (!completedSession) {
    return sendErrorPage({
      reply: params.reply,
      statusCode: 400,
      title: "Sign-in not ready",
      message: "This sign-in request is not ready for confirmation yet. Return to Sesori and try again.",
    });
  }

  return sendSuccessPage({
    reply: params.reply,
    title: "Sign-in confirmed",
    message: "You're all set. Return to Sesori to finish signing in.",
  });
}

function sendConfirmationPage(params: {
  reply: FastifyReply;
  providerName: OAuthProviderName;
  session: PendingAuthSession;
}): FastifyReply {
  // Provider names are enum-bounded; encodeURIComponent is defense-in-depth so
  // a future contributor cannot accidentally introduce an open-action bug by
  // widening the enum to a user-influenced value.
  const formAction = `/auth/${encodeURIComponent(params.providerName)}/callback/confirm`;
  return params.reply.status(200).type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Confirm Sesori sign-in</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
      .card { max-width: 480px; margin: 48px auto; background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 24px; }
      .device { margin: 16px 0; padding: 16px; background: #0f172a; border: 1px solid #334155; border-radius: 12px; }
      .device-name { font-size: 20px; font-weight: 700; }
      .device-meta { margin-top: 4px; color: #94a3b8; font-size: 14px; }
      .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
      button { border: 0; border-radius: 999px; padding: 12px 18px; font: inherit; cursor: pointer; }
      .confirm { background: #22c55e; color: #052e16; }
      .deny { background: #334155; color: #e2e8f0; }
      p { line-height: 1.5; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Confirm Sesori sign-in</h1>
      <p>You're signing in with ${escapeHtml(params.providerName)}. Only continue if you just started this sign-in from the device below.</p>
      ${renderRequestingDeviceHtml(params.session)}
      <p>Sesori will finish sign-in only after you explicitly confirm here.</p>
      <div class="actions">
        <form method="POST" action="${escapeHtml(formAction)}">
          <input type="hidden" name="state" value="${escapeHtml(params.session.state)}" />
          <input type="hidden" name="action" value="confirm" />
          <button class="confirm" type="submit">Confirm</button>
        </form>
        <form method="POST" action="${escapeHtml(formAction)}">
          <input type="hidden" name="state" value="${escapeHtml(params.session.state)}" />
          <input type="hidden" name="action" value="deny" />
          <button class="deny" type="submit">Cancel</button>
        </form>
      </div>
    </main>
  </body>
</html>`);
}

/**
 * Renders the "requesting device" panel for the confirmation page. Returns
 * fully HTML-escaped markup. When the client supplied a `device` object the
 * human-readable name is shown prominently; otherwise we fall back to a generic
 * message that still names the device type/OS derived from the trusted,
 * enum-bounded `clientType`.
 */
function renderRequestingDeviceHtml(session: PendingAuthSession): string {
  const typeLabel = describeClientType(session.clientType);
  const device = session.device;

  if (!device) {
    return `<div class="device"><div class="device-meta">A ${escapeHtml(typeLabel)} is requesting to sign in.</div></div>`;
  }

  const meta = [typeLabel];
  if (device.osVersion) {
    meta.push(device.osVersion);
  }
  if (device.appVersion) {
    meta.push(`Sesori ${device.appVersion}`);
  }

  return `<div class="device"><div class="device-name">${escapeHtml(device.name)}</div><div class="device-meta">${escapeHtml(meta.join(" · "))}</div></div>`;
}

/**
 * Maps the enum-bounded `clientType` to a human-readable "device type + OS
 * family" label. This is the trustworthy half of the device description — it
 * cannot be set to arbitrary text (unlike the free-text device name).
 */
function describeClientType(clientType: OAuthClientType | undefined): string {
  switch (clientType) {
    case OAuthClientType.BridgeMacOS:
    case OAuthClientType.AppMacOS:
      return "macOS desktop";
    case OAuthClientType.BridgeWindows:
    case OAuthClientType.AppWindows:
      return "Windows desktop";
    case OAuthClientType.BridgeLinux:
    case OAuthClientType.AppLinux:
      return "Linux desktop";
    case OAuthClientType.AppIOS:
      return "iPhone or iPad";
    case OAuthClientType.AppAndroid:
      return "Android device";
    case OAuthClientType.Bridge:
      return "desktop app";
    case OAuthClientType.App:
      return "mobile app";
    case undefined:
      return "device";
  }
}

function sendSuccessPage(params: { reply: FastifyReply; title: string; message: string }): FastifyReply {
  return params.reply.status(200).type("text/html; charset=utf-8").send(renderMessagePage(params));
}

function sendDeniedPage(params: { reply: FastifyReply; title: string; message: string }): FastifyReply {
  return params.reply
    .status(200)
    .type("text/html; charset=utf-8")
    .send(renderMessagePage({ title: params.title, message: params.message }));
}

function sendErrorPage(params: {
  reply: FastifyReply;
  statusCode: number;
  title: string;
  message: string;
}): FastifyReply {
  return params.reply.status(params.statusCode).type("text/html; charset=utf-8").send(renderMessagePage(params));
}

function renderMessagePage(params: { title: string; message: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(params.title)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
      .card { max-width: 480px; margin: 48px auto; background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 24px; }
      p { line-height: 1.5; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>${escapeHtml(params.title)}</h1>
      <p>${escapeHtml(params.message)}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncateForDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  // Split on grapheme/UTF-16 code-point boundaries so we don't leave an
  // unpaired surrogate at the slice point if the input contains emoji.
  const truncated = Array.from(value).slice(0, maxLength).join("");
  return `${truncated}…`;
}

/**
 * Registers the `/auth/{provider}/callback/confirm` POST endpoint inside an
 * encapsulated Fastify plugin scope. The `application/x-www-form-urlencoded`
 * parser is registered ONLY within this scope so other endpoints continue to
 * accept JSON bodies exclusively (AR-3 / DC-9).
 */
export async function registerProviderConfirmRoute(
  fastify: FastifyInstance,
  options: { providerName: OAuthProviderName; pendingAuthStore: PendingAuthStore },
): Promise<void> {
  const plugin: FastifyPluginAsync = async (scope) => {
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      try {
        const params = new URLSearchParams(body as string);
        const result: Record<string, string> = {};
        for (const [key, value] of params) {
          result[key] = value;
        }
        done(null, result);
      } catch (err) {
        done(err as Error);
      }
    });

    scope.post(`/auth/${options.providerName}/callback/confirm`, async (request, reply) => {
      return await handleProviderCallbackAction({
        request,
        reply,
        pendingAuthStore: options.pendingAuthStore,
      });
    });
  };

  await fastify.register(plugin);
}

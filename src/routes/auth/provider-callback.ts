import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { OAuthClient } from "../../clients/auth/oauth-client.js";
import type { AuthService } from "../../services/auth-service.js";
import type { PendingAuthStore, PendingAuthSession } from "../../services/pending-auth-store.js";
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

const callbackActionQuerySchema = z.object({
  state: z.string().min(1),
  action: z.enum(["confirm", "deny"]),
});

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

  const { code, error, error_description, state } = queryResult.data;
  const stateResult = pendingStateSchema.safeParse(state);
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

  if (error) {
    if (error === "access_denied") {
      params.deps.pendingAuthStore.denySession(session.tokenHash);
      return sendDeniedPage({
        reply: params.reply,
        userCode: session.userCode,
        title: "Sign-in cancelled",
        message: "You cancelled this sign-in request. You can return to Sesori and try again.",
      });
    }

    params.deps.pendingAuthStore.failSession({
      tokenHash: session.tokenHash,
      errorMessage: error_description ?? error,
    });
    return sendErrorPage({
      reply: params.reply,
      statusCode: 400,
      title: "Sign-in failed",
      message: error_description ?? "The provider rejected this sign-in request.",
    });
  }

  switch (session.status) {
    case "awaiting_confirmation":
      return sendConfirmationPage({ reply: params.reply, providerName: params.deps.providerName, session });
    case "complete":
    case "consumed":
      return sendSuccessPage({
        reply: params.reply,
        title: "Sign-in already confirmed",
        message: "This sign-in request has already been confirmed in Sesori.",
      });
    case "denied":
      return sendDeniedPage({
        reply: params.reply,
        userCode: session.userCode,
        title: "Sign-in cancelled",
        message: "This sign-in request was cancelled. Return to Sesori to start again.",
      });
    case "expired":
      return sendErrorPage({
        reply: params.reply,
        statusCode: 410,
        title: "Sign-in request expired",
        message: "This sign-in request has expired. Please start again from Sesori.",
      });
    case "error":
      return sendErrorPage({
        reply: params.reply,
        statusCode: 400,
        title: "Sign-in failed",
        message: session.errorMessage ?? "This sign-in request could not be completed.",
      });
    case "pending":
      break;
  }

  try {
    const result = await params.deps.authService.authenticateOAuth(
      params.deps.providerName,
      params.deps.providerClient,
      {
        code: code!,
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
  } catch {
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

export async function handleProviderCallbackAction(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  pendingAuthStore: PendingAuthStore;
}): Promise<FastifyReply> {
  const queryResult = callbackActionQuerySchema.safeParse(params.request.query);
  if (!queryResult.success) {
    return sendErrorPage({
      reply: params.reply,
      statusCode: 400,
      title: "Invalid confirmation request",
      message: "The confirmation action was missing required information.",
    });
  }

  const stateResult = pendingStateSchema.safeParse(queryResult.data.state);
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

  if (queryResult.data.action === "deny") {
    params.pendingAuthStore.denySession(session.tokenHash);
    return sendDeniedPage({
      reply: params.reply,
      userCode: session.userCode,
      title: "Sign-in cancelled",
      message: "This sign-in request was cancelled. Return to Sesori and try again when you're ready.",
    });
  }

  if (session.status === "complete" || session.status === "consumed") {
    return sendSuccessPage({
      reply: params.reply,
      title: "Sign-in already confirmed",
      message: "This sign-in request has already been confirmed in Sesori.",
    });
  }

  if (session.status === "denied") {
    return sendDeniedPage({
      reply: params.reply,
      userCode: session.userCode,
      title: "Sign-in cancelled",
      message: "This sign-in request was already cancelled.",
    });
  }

  if (session.status === "error") {
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
    message: `You're all set. Return to Sesori and enter code ${completedSession.userCode} if prompted.`,
  });
}

function sendConfirmationPage(params: {
  reply: FastifyReply;
  providerName: OAuthProviderName;
  session: PendingAuthSession;
}): FastifyReply {
  return params.reply.status(200).type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Confirm Sesori sign-in</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
      .card { max-width: 480px; margin: 48px auto; background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 24px; }
      .code { font-size: 32px; font-weight: 700; letter-spacing: 0.18em; margin: 16px 0; }
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
      <p>You're signing in with ${escapeHtml(params.providerName)}. Make sure this 4-character code matches the Sesori app before continuing.</p>
      <div class="code">${escapeHtml(params.session.userCode)}</div>
      <p>Sesori will finish sign-in only after you explicitly confirm here.</p>
      <div class="actions">
        <form method="GET" action="/auth/${escapeHtml(params.providerName)}/callback/confirm">
          <input type="hidden" name="state" value="${escapeHtml(params.session.state)}" />
          <input type="hidden" name="action" value="confirm" />
          <button class="confirm" type="submit">Confirm</button>
        </form>
        <form method="GET" action="/auth/${escapeHtml(params.providerName)}/callback/confirm">
          <input type="hidden" name="state" value="${escapeHtml(params.session.state)}" />
          <input type="hidden" name="action" value="deny" />
          <button class="deny" type="submit">Cancel</button>
        </form>
      </div>
    </main>
  </body>
</html>`);
}

function sendSuccessPage(params: { reply: FastifyReply; title: string; message: string }): FastifyReply {
  return params.reply.status(200).type("text/html; charset=utf-8").send(renderMessagePage(params));
}

function sendDeniedPage(params: {
  reply: FastifyReply;
  userCode: string;
  title: string;
  message: string;
}): FastifyReply {
  return params.reply
    .status(200)
    .type("text/html; charset=utf-8")
    .send(renderMessagePage({ title: params.title, message: `${params.message} Code ${params.userCode}.` }));
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

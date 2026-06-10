import { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { OAuthClient } from "../../clients/auth/oauth-client.js";
import { OAuthProviderName } from "../../types/oauth.js";
import type { Config } from "../../config.js";
import { BadRequestError } from "../../lib/errors.js";
import { isAllowedRedirectUri, isLocalhostRedirectUri } from "../../lib/redirect-uri.js";
import type { StateStore } from "../../lib/state-store.js";
import type { OAuthInitQuery, OAuthInitReply, OAuthPendingInitReply } from "../../models/api.js";
import type { AuthService } from "../../services/auth-service.js";
import type { PendingAuthStore } from "../../services/pending-auth-store.js";
import {
  createOAuthPendingInitReply,
  createPendingOAuthInit,
  getProviderCallbackRedirectUri,
  parseOAuthPendingInitBody,
  parseSessionTokenHeader,
} from "./init.js";
import { handleProviderCallbackAction, handleProviderCallbackRedirect } from "./provider-callback.js";

const appleInitQuerySchema = z.object({
  redirect_uri: z.string().min(1),
  code_challenge: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/, "Invalid PKCE code_challenge"),
  code_challenge_method: z.literal("S256").default("S256"),
});

const appleCallbackBodySchema = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
  state: z.string().min(1),
  redirectUri: z.string().min(1),
});

const appleFormPostSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().min(1).optional(),
  error_description: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
});

export type AppleRouteOptions = {
  config: Config;
  authService: AuthService;
  stateStore: StateStore;
  appleClient: OAuthClient;
  pendingAuthStore: PendingAuthStore;
};

export const appleRoutes: FastifyPluginAsync<AppleRouteOptions> = async (fastify, opts) => {
  const { config, authService, stateStore, appleClient, pendingAuthStore } = opts;

  // Apple uses response_mode=form_post, so the callback arrives as POST
  // with application/x-www-form-urlencoded body instead of query params.
  fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
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

  fastify.get<{ Querystring: OAuthInitQuery; Reply: OAuthInitReply }>("/auth/apple", async (request) => {
    const queryResult = appleInitQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      throw new BadRequestError({ debugMessage: "Invalid query parameters", nestedError: queryResult.error.issues });
    }

    const { redirect_uri, code_challenge, code_challenge_method } = queryResult.data;
    if (!isAllowedRedirectUri(redirect_uri, config.ALLOWED_REDIRECT_URIS)) {
      throw new BadRequestError({ debugMessage: "Redirect URI not allowed" });
    }
    if (!redirect_uri.startsWith("https://") && !isLocalhostRedirectUri(redirect_uri)) {
      throw new BadRequestError({ debugMessage: "Apple web flow requires an HTTPS redirect URI" });
    }

    const state = stateStore.createState();
    const authUrl = new URL("https://appleid.apple.com/auth/authorize");
    authUrl.searchParams.set("client_id", config.APPLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirect_uri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "name email");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", code_challenge);
    authUrl.searchParams.set("code_challenge_method", code_challenge_method);
    authUrl.searchParams.set("response_mode", "form_post");

    return {
      authUrl: authUrl.toString(),
      state,
    };
  });

  fastify.post<{ Body: unknown; Reply: OAuthPendingInitReply }>("/auth/apple/init", async (request) => {
    parseOAuthPendingInitBody(request.body);

    const sessionToken = parseSessionTokenHeader(request.headers["x-sesori-session-token"]);
    const { session, codeChallenge } = createPendingOAuthInit({
      provider: OAuthProviderName.Apple,
      pendingAuthStore,
      sessionToken,
    });

    const authUrl = new URL("https://appleid.apple.com/auth/authorize");
    authUrl.searchParams.set("client_id", config.APPLE_CLIENT_ID);
    authUrl.searchParams.set(
      "redirect_uri",
      getProviderCallbackRedirectUri(config.AUTH_BASE_URL, OAuthProviderName.Apple),
    );
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "name email");
    authUrl.searchParams.set("state", session.state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("response_mode", "form_post");

    return createOAuthPendingInitReply({ session, authUrl });
  });

  // Apple uses response_mode=form_post, so the callback arrives as POST
  // with application/x-www-form-urlencoded body instead of query params.
  // This single handler supports both the legacy JSON callback and the
  // new pending-session form_post callback.
  fastify.post("/auth/apple/callback", async (request, reply) => {
    const jsonResult = appleCallbackBodySchema.safeParse(request.body);
    if (jsonResult.success) {
      const { code, codeVerifier, state, redirectUri } = jsonResult.data;
      if (!isAllowedRedirectUri(redirectUri, config.ALLOWED_REDIRECT_URIS)) {
        throw new BadRequestError({ debugMessage: "Redirect URI not allowed" });
      }
      if (!stateStore.validateState(state)) {
        throw new BadRequestError({ debugMessage: "Invalid or expired state" });
      }
      return await authService.authenticateOAuth(OAuthProviderName.Apple, appleClient, {
        code,
        codeVerifier,
        redirectUri,
        clientId: config.APPLE_CLIENT_ID,
      });
    }

    const formResult = appleFormPostSchema.safeParse(request.body);
    if (!formResult.success) {
      return sendErrorPage({
        reply,
        statusCode: 400,
        title: "Invalid sign-in callback",
        message: "The Apple callback was missing required information.",
      });
    }

    const { code, state, error, error_description, id_token } = formResult.data;

    // Apple may return id_token directly instead of code in some configurations.
    // For the pending session flow we always expect a code.
    if (!code && id_token) {
      return sendErrorPage({
        reply,
        statusCode: 400,
        title: "Unsupported Apple response",
        message: "This Apple sign-in configuration is not supported. Please try again.",
      });
    }

    return await handleProviderCallbackRedirect({
      request: {
        ...request,
        query: { code, state, error, error_description },
      } as typeof request,
      reply,
      deps: {
        providerName: OAuthProviderName.Apple,
        providerClient: appleClient,
        authService,
        pendingAuthStore,
        clientId: config.APPLE_CLIENT_ID,
        callbackRedirectUri: getProviderCallbackRedirectUri(config.AUTH_BASE_URL, OAuthProviderName.Apple),
      },
    });
  });

  fastify.post("/auth/apple/callback/confirm", async (request, reply) => {
    return await handleProviderCallbackAction({
      request,
      reply,
      pendingAuthStore,
    });
  });
};

function sendErrorPage(params: {
  reply: FastifyReply;
  statusCode: number;
  title: string;
  message: string;
}): FastifyReply {
  return params.reply
    .status(params.statusCode)
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(params.title)}</title></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px;">
    <div style="max-width: 480px; margin: 48px auto; background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 24px;">
      <h1>${escapeHtml(params.title)}</h1>
      <p>${escapeHtml(params.message)}</p>
    </div>
  </body>
</html>`,
    );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

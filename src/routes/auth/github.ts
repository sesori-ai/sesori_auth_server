import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { GithubClient } from "../../clients/auth/github-client.js";
import { OAuthProviderName } from "../../types/oauth.js";
import type { Config } from "../../config.js";
import { BadRequestError } from "../../lib/errors.js";
import { isAllowedRedirectUri } from "../../lib/redirect-uri.js";
import type { StateStore } from "../../lib/state-store.js";
import type {
  OAuthInitQuery,
  OAuthInitReply,
  OAuthCallbackBody,
  AuthTokensReply,
  OAuthPendingInitReply,
} from "../../models/api.js";
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

const githubInitQuerySchema = z.object({
  redirect_uri: z.string().min(1),
  code_challenge: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/, "Invalid PKCE code_challenge"),
  code_challenge_method: z.literal("S256").default("S256"),
});

const githubCallbackBodySchema = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
  state: z.string().min(1),
  redirectUri: z.string().min(1),
});

export type GithubRouteOptions = {
  config: Config;
  authService: AuthService;
  stateStore: StateStore;
  githubClient: GithubClient;
  pendingAuthStore: PendingAuthStore;
};

export const githubRoutes: FastifyPluginAsync<GithubRouteOptions> = async (fastify, opts) => {
  const { config, authService, stateStore, githubClient, pendingAuthStore } = opts;

  fastify.get<{ Querystring: OAuthInitQuery; Reply: OAuthInitReply }>("/auth/github", async (request) => {
    const queryResult = githubInitQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      throw new BadRequestError({ debugMessage: "Invalid query parameters", nestedError: queryResult.error.issues });
    }

    const { redirect_uri, code_challenge, code_challenge_method } = queryResult.data;
    if (!isAllowedRedirectUri(redirect_uri, config.ALLOWED_REDIRECT_URIS)) {
      throw new BadRequestError({ debugMessage: "Redirect URI not allowed" });
    }

    const state = stateStore.createState();
    const authUrl = new URL("https://github.com/login/oauth/authorize");
    authUrl.searchParams.set("client_id", config.GITHUB_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirect_uri);
    authUrl.searchParams.set("scope", "read:user");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", code_challenge);
    authUrl.searchParams.set("code_challenge_method", code_challenge_method);

    return {
      authUrl: authUrl.toString(),
      state,
    };
  });

  fastify.post<{ Body: unknown; Reply: OAuthPendingInitReply }>("/auth/github/init", async (request) => {
    parseOAuthPendingInitBody(request.body);

    const sessionToken = parseSessionTokenHeader(request.headers["x-sesori-session-token"]);
    const { session, codeChallenge } = createPendingOAuthInit({
      provider: OAuthProviderName.Github,
      pendingAuthStore,
      sessionToken,
    });

    const authUrl = new URL("https://github.com/login/oauth/authorize");
    authUrl.searchParams.set("client_id", config.GITHUB_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", getProviderCallbackRedirectUri(OAuthProviderName.Github));
    authUrl.searchParams.set("scope", "read:user");
    authUrl.searchParams.set("state", session.state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    return createOAuthPendingInitReply({ session, authUrl });
  });

  fastify.post<{ Body: OAuthCallbackBody; Reply: AuthTokensReply }>("/auth/github/callback", async (request) => {
    const bodyResult = githubCallbackBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
    }

    const { code, codeVerifier, state, redirectUri } = bodyResult.data;
    if (!isAllowedRedirectUri(redirectUri, config.ALLOWED_REDIRECT_URIS)) {
      throw new BadRequestError({ debugMessage: "Redirect URI not allowed" });
    }

    if (!stateStore.validateState(state)) {
      throw new BadRequestError({ debugMessage: "Invalid or expired state" });
    }

    return await authService.authenticateOAuth(OAuthProviderName.Github, githubClient, {
      code,
      codeVerifier,
      redirectUri,
      clientId: config.GITHUB_CLIENT_ID,
      clientSecret: config.GITHUB_CLIENT_SECRET,
    });
  });

  fastify.get("/auth/github/callback", async (request, reply) => {
    return await handleProviderCallbackRedirect({
      request,
      reply,
      deps: {
        providerName: OAuthProviderName.Github,
        providerClient: githubClient,
        authService,
        pendingAuthStore,
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
        callbackRedirectUri: getProviderCallbackRedirectUri(OAuthProviderName.Github),
      },
    });
  });

  fastify.get("/auth/github/callback/confirm", async (request, reply) => {
    return await handleProviderCallbackAction({
      request,
      reply,
      pendingAuthStore,
    });
  });
};

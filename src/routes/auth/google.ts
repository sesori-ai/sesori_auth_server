import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { GoogleClient } from "../../clients/auth/google-client.js";
import { OAuthProviderName } from "../../types/oauth.js";
import type { Config } from "../../config.js";
import { BadRequestError } from "../../lib/errors.js";
import { isAllowedRedirectUri } from "../../lib/redirect-uri.js";
import type { StateStore } from "../../lib/state-store.js";
import type { OAuthInitQuery, OAuthInitReply, OAuthCallbackBody, AuthTokensReply } from "../../models/api.js";
import type { AuthService } from "../../services/auth-service.js";

const googleInitQuerySchema = z.object({
  redirect_uri: z.string().min(1),
  code_challenge: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/, "Invalid PKCE code_challenge"),
  code_challenge_method: z.literal("S256").default("S256"),
});

const googleCallbackBodySchema = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
  state: z.string().min(1),
  redirectUri: z.string().min(1),
});

export type GoogleRouteOptions = {
  config: Config;
  authService: AuthService;
  stateStore: StateStore;
  googleClient: GoogleClient;
};

export const googleRoutes: FastifyPluginAsync<GoogleRouteOptions> = async (fastify, opts) => {
  const { config, authService, stateStore, googleClient } = opts;

  fastify.get<{ Querystring: OAuthInitQuery; Reply: OAuthInitReply }>("/auth/google", async (request) => {
    const queryResult = googleInitQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      throw new BadRequestError({ debugMessage: "Invalid query parameters", nestedError: queryResult.error.issues });
    }

    const { redirect_uri, code_challenge, code_challenge_method } = queryResult.data;
    if (!isAllowedRedirectUri(redirect_uri, config.ALLOWED_REDIRECT_URIS)) {
      throw new BadRequestError({ debugMessage: "Redirect URI not allowed" });
    }

    const state = stateStore.createState();
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirect_uri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid profile email");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", code_challenge);
    authUrl.searchParams.set("code_challenge_method", code_challenge_method);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    return {
      authUrl: authUrl.toString(),
      state,
    };
  });

  fastify.post<{ Body: OAuthCallbackBody; Reply: AuthTokensReply }>("/auth/google/callback", async (request) => {
    const bodyResult = googleCallbackBodySchema.safeParse(request.body);
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

    return await authService.authenticateOAuth(OAuthProviderName.Google, googleClient, {
      code,
      codeVerifier,
      redirectUri,
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
    });
  });
};

import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { BadRequestError } from "../lib/errors.js";
import { StateStore } from "../lib/state-store.js";
import type { OAuthInitQuery, OAuthInitReply, OAuthCallbackBody, AuthTokensReply } from "../models/api.js";
import { AuthService } from "../services/auth-service.js";

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

export const githubRoutes: FastifyPluginAsync = async (fastify) => {
  const config = loadConfig();

  fastify.get<{ Querystring: OAuthInitQuery; Reply: OAuthInitReply }>("/auth/github", async (request) => {
    const queryResult = githubInitQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      throw new BadRequestError({ debugMessage: "Invalid query parameters", nestedError: queryResult.error.errors });
    }

    const { redirect_uri, code_challenge, code_challenge_method } = queryResult.data;

    const state = StateStore.createState();
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

  fastify.post<{ Body: OAuthCallbackBody; Reply: AuthTokensReply }>("/auth/github/callback", async (request) => {
    const bodyResult = githubCallbackBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.errors });
    }

    const { code, codeVerifier, state, redirectUri } = bodyResult.data;
    if (!StateStore.validateState(state)) {
      throw new BadRequestError({ debugMessage: "Invalid or expired state" });
    }

    return await AuthService.authenticateGithub({
      code,
      codeVerifier,
      redirectUri,
      clientId: config.GITHUB_CLIENT_ID,
      clientSecret: config.GITHUB_CLIENT_SECRET,
    });
  });
};

import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { StateStore } from "../lib/state-store.js";
import { AuthService, AuthServiceError } from "../services/auth-service.js";

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

type GithubInitQuery = z.infer<typeof githubInitQuerySchema>;
type GithubInitReply = { authUrl: string; state: string };

type GithubCallbackBody = z.infer<typeof githubCallbackBodySchema>;
type GithubCallbackReply = {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    provider: string;
    providerUserId: string;
    providerUsername: string | null;
  };
};

type ErrorReply = { error: string; details?: unknown };

const GITHUB_ERRORS: Record<string, string> = {
  GITHUB_TOKEN_EXCHANGE_FAILED: "GitHub token exchange failed",
  INVALID_GITHUB_TOKEN_RESPONSE: "Invalid GitHub token response",
  GITHUB_USER_FETCH_FAILED: "GitHub user fetch failed",
  INVALID_GITHUB_USER_RESPONSE: "Invalid GitHub user response",
};

export const githubRoutes: FastifyPluginAsync = async (fastify) => {
  const config = loadConfig();

  fastify.get<{ Querystring: GithubInitQuery; Reply: GithubInitReply | ErrorReply }>(
    "/auth/github",
    async (request, reply) => {
      const queryResult = githubInitQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        reply.status(400).send({
          error: "Invalid query parameters",
          details: queryResult.error.errors,
        });
        return;
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
    },
  );

  fastify.post<{ Body: GithubCallbackBody; Reply: GithubCallbackReply | ErrorReply }>(
    "/auth/github/callback",
    async (request, reply) => {
      const bodyResult = githubCallbackBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        reply.status(400).send({
          error: "Invalid request body",
          details: bodyResult.error.errors,
        });
        return;
      }

      const { code, codeVerifier, state, redirectUri } = bodyResult.data;
      if (!StateStore.validateState(state)) {
        reply.status(400).send({ error: "Invalid or expired state" });
        return;
      }

      try {
        return await AuthService.authenticateGithub({
          code,
          codeVerifier,
          redirectUri,
          clientId: config.GITHUB_CLIENT_ID,
          clientSecret: config.GITHUB_CLIENT_SECRET,
        });
      } catch (error) {
        if (error instanceof AuthServiceError && error.code in GITHUB_ERRORS) {
          request.log.warn(error, GITHUB_ERRORS[error.code]);
          reply.status(502).send({ error: error.code.toLowerCase() });
          return;
        }

        throw error;
      }
    },
  );
};

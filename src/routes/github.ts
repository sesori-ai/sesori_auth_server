import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { StateStore } from "../lib/state-store.js";
import { AuthService, AuthServiceError } from "../services/auth-service.js";

const githubInitQuerySchema = z.object({
  redirect_uri: z.string().min(1),
  code_challenge: z
    .string()
    .regex(/^[A-Za-z0-9\-._~]{43,128}$/, "Invalid PKCE code_challenge"),
  code_challenge_method: z.literal("S256").default("S256"),
});

const githubCallbackBodySchema = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
  state: z.string().min(1),
  redirectUri: z.string().min(1),
});

const GITHUB_ERRORS: Record<string, string> = {
  GITHUB_TOKEN_EXCHANGE_FAILED: "GitHub token exchange failed",
  INVALID_GITHUB_TOKEN_RESPONSE: "Invalid GitHub token response",
  GITHUB_USER_FETCH_FAILED: "GitHub user fetch failed",
  INVALID_GITHUB_USER_RESPONSE: "Invalid GitHub user response",
};

export const githubRoutes: FastifyPluginAsync = async (fastify) => {
  const config = loadConfig();

  fastify.get("/auth/github", async (request, reply) => {
    const queryResult = githubInitQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({
        error: "Invalid query parameters",
        details: queryResult.error.errors,
      });
    }

    const { redirect_uri, code_challenge, code_challenge_method } =
      queryResult.data;

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

  fastify.post("/auth/github/callback", async (request, reply) => {
    const bodyResult = githubCallbackBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: bodyResult.error.errors,
      });
    }

    const { code, codeVerifier, state, redirectUri } = bodyResult.data;
    if (!StateStore.validateState(state)) {
      return reply.status(400).send({ error: "Invalid or expired state" });
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
        return reply.status(502).send({ error: error.code.toLowerCase() });
      }

      throw error;
    }
  });
};

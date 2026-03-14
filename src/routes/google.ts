import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { StateStore } from "../lib/state-store.js";
import { AuthService, AuthServiceError } from "../services/auth-service.js";

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

type GoogleInitQuery = z.infer<typeof googleInitQuerySchema>;
type GoogleInitReply = { authUrl: string; state: string };

type GoogleCallbackBody = z.infer<typeof googleCallbackBodySchema>;
type GoogleCallbackReply = {
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

const GOOGLE_ERRORS: Record<string, string> = {
  GOOGLE_TOKEN_EXCHANGE_FAILED: "Google token exchange failed",
  INVALID_GOOGLE_TOKEN_RESPONSE: "Invalid Google token response",
  INVALID_GOOGLE_ID_TOKEN: "Failed to decode Google ID token",
  INVALID_GOOGLE_ID_TOKEN_PAYLOAD: "Invalid Google ID token payload",
};

export const googleRoutes: FastifyPluginAsync = async (fastify) => {
  const config = loadConfig();

  fastify.get<{ Querystring: GoogleInitQuery; Reply: GoogleInitReply | ErrorReply }>(
    "/auth/google",
    async (request, reply) => {
      const queryResult = googleInitQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        reply.status(400).send({
          error: "Invalid query parameters",
          details: queryResult.error.errors,
        });
        return;
      }

      const { redirect_uri, code_challenge, code_challenge_method } = queryResult.data;

      const state = StateStore.createState();
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirect_uri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid profile");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", code_challenge);
      authUrl.searchParams.set("code_challenge_method", code_challenge_method);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");

      return {
        authUrl: authUrl.toString(),
        state,
      };
    },
  );

  fastify.post<{ Body: GoogleCallbackBody; Reply: GoogleCallbackReply | ErrorReply }>(
    "/auth/google/callback",
    async (request, reply) => {
      const bodyResult = googleCallbackBodySchema.safeParse(request.body);
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
        return await AuthService.authenticateGoogle({
          code,
          codeVerifier,
          redirectUri,
          clientId: config.GOOGLE_CLIENT_ID,
          clientSecret: config.GOOGLE_CLIENT_SECRET,
        });
      } catch (error) {
        if (error instanceof AuthServiceError && error.code in GOOGLE_ERRORS) {
          request.log.warn(error, GOOGLE_ERRORS[error.code]);
          reply.status(502).send({ error: error.code.toLowerCase() });
          return;
        }

        throw error;
      }
    },
  );
};

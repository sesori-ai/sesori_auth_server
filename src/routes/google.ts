import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { createState, validateState } from "../lib/state-store.js";
import {
  authenticateGoogle,
  AuthServiceError,
} from "../services/auth-service.js";

const googleInitQuerySchema = z.object({
  redirect_uri: z.string().min(1),
  code_challenge: z
    .string()
    .regex(/^[A-Za-z0-9\-._~]{43,128}$/, "Invalid PKCE code_challenge"),
  code_challenge_method: z.enum(["S256", "plain"]).default("S256"),
});

const googleCallbackBodySchema = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
  state: z.string().min(1),
  redirectUri: z.string().min(1),
});

export const googleRoutes: FastifyPluginAsync = async (fastify) => {
  const config = loadConfig();

  fastify.get("/auth/google", async (request, reply) => {
    const queryResult = googleInitQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({
        error: "Invalid query parameters",
        details: queryResult.error.errors,
      });
    }

    const { redirect_uri, code_challenge, code_challenge_method } = queryResult.data;
    const state = createState();

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
  });

  fastify.post("/auth/google/callback", async (request, reply) => {
    const bodyResult = googleCallbackBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: bodyResult.error.errors,
      });
    }

    const { code, codeVerifier, state, redirectUri } = bodyResult.data;
    if (!validateState(state)) {
      return reply.status(400).send({ error: "Invalid or expired state" });
    }

    try {
      return await authenticateGoogle({
        code,
        codeVerifier,
        redirectUri,
        clientId: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
      });
    } catch (error) {
      if (error instanceof AuthServiceError) {
        if (error.code === "GOOGLE_TOKEN_EXCHANGE_FAILED") {
          request.log.warn(error, "Google token exchange failed");
          return reply.status(502).send({ error: "Google token exchange failed" });
        }
        if (error.code === "INVALID_GOOGLE_TOKEN_RESPONSE") {
          request.log.warn(error, "Invalid Google token response");
          return reply.status(502).send({ error: "Invalid Google token response" });
        }
        if (error.code === "INVALID_GOOGLE_ID_TOKEN") {
          request.log.warn(error, "Failed to decode Google ID token");
          return reply.status(502).send({ error: "Invalid Google ID token" });
        }
        if (error.code === "INVALID_GOOGLE_ID_TOKEN_PAYLOAD") {
          request.log.warn(error, "Invalid Google ID token payload");
          return reply
            .status(502)
            .send({ error: "Invalid Google ID token payload" });
        }
      }

      throw error;
    }
  });
};

import { FastifyPluginAsync } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { oauthAccounts, users } from "../db/collections.js";
import { signAccessToken, signRefreshToken } from "./jwt.js";
import { createState, validateState } from "./state-store.js";

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

const googleTokenResponseSchema = z.object({
  access_token: z.string(),
  id_token: z.string(),
  refresh_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const googleIdTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  name: z.string().optional(),
  given_name: z.string().optional(),
});

function decodeJwtPayload(idToken: string): unknown {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }

  const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const payloadJson = Buffer.from(padded, "base64").toString("utf8");

  return JSON.parse(payloadJson) as unknown;
}

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

    const { redirect_uri, code_challenge, code_challenge_method } =
      queryResult.data;

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

    const tokenParams = new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    });

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      request.log.warn(
        { status: tokenResponse.status },
        "Google token exchange failed"
      );
      return reply.status(502).send({ error: "Google token exchange failed" });
    }

    const tokenJson = await tokenResponse.json();
    const tokenParse = googleTokenResponseSchema.safeParse(tokenJson);
    if (!tokenParse.success || tokenParse.data.error) {
      request.log.warn(
        { tokenResponse: tokenJson },
        "Invalid Google token response"
      );
      return reply.status(502).send({ error: "Invalid Google token response" });
    }

    let idTokenPayloadRaw: unknown;
    try {
      idTokenPayloadRaw = decodeJwtPayload(tokenParse.data.id_token);
    } catch (error) {
      request.log.warn(error, "Failed to decode Google ID token");
      return reply.status(502).send({ error: "Invalid Google ID token" });
    }

    const idTokenPayloadParse = googleIdTokenPayloadSchema.safeParse(
      idTokenPayloadRaw
    );
    if (!idTokenPayloadParse.success) {
      request.log.warn(
        { payload: idTokenPayloadRaw },
        "Invalid Google ID token payload"
      );
      return reply.status(502).send({ error: "Invalid Google ID token payload" });
    }

    const providerUserId = idTokenPayloadParse.data.sub;
    const providerUsername =
      idTokenPayloadParse.data.name ?? idTokenPayloadParse.data.given_name ?? null;
    const googleAccessToken = tokenParse.data.access_token;
    const googleRefreshToken = tokenParse.data.refresh_token;
    const now = new Date();

    const existingOauthAccount = await oauthAccounts().findOne({
      provider: "google",
      providerUserId,
    });

    let userId: ObjectId;

    if (existingOauthAccount) {
      userId = existingOauthAccount.userId;
      const updateSet: {
        accessToken: string;
        providerUsername: string | null;
        updatedAt: Date;
        refreshToken?: string;
      } = {
        accessToken: googleAccessToken,
        providerUsername,
        updatedAt: now,
      };

      if (googleRefreshToken) {
        updateSet.refreshToken = googleRefreshToken;
      }

      await oauthAccounts().updateOne(
        { _id: existingOauthAccount._id },
        { $set: updateSet }
      );
    } else {
      userId = new ObjectId();
      await users().insertOne({
        _id: userId,
        createdAt: now,
        updatedAt: now,
      });

      await oauthAccounts().insertOne({
        _id: new ObjectId(),
        userId,
        provider: "google",
        providerUserId,
        providerUsername,
        accessToken: googleAccessToken,
        refreshToken: googleRefreshToken ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const accessToken = signAccessToken({
      userId: userId.toHexString(),
      provider: "google",
      providerUserId,
    });
    const refreshToken = signRefreshToken({ userId: userId.toHexString() });

    return {
      accessToken,
      refreshToken,
      user: {
        id: userId.toHexString(),
        provider: "google",
        providerUserId,
        providerUsername,
      },
    };
  });
};

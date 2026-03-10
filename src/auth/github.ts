import { FastifyPluginAsync } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { oauthAccounts, users } from "../db/collections.js";
import { signAccessToken, signRefreshToken } from "./jwt.js";
import { createState, validateState } from "./state-store.js";

const githubInitQuerySchema = z.object({
  redirect_uri: z.string().min(1),
  code_challenge: z
    .string()
    .regex(/^[A-Za-z0-9\-._~]{43,128}$/, "Invalid PKCE code_challenge"),
  code_challenge_method: z.enum(["S256", "plain"]).default("S256"),
});

const githubCallbackBodySchema = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
  state: z.string().min(1),
  redirectUri: z.string().min(1),
});

const githubAccessTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const githubUserResponseSchema = z.object({
  id: z.number(),
  login: z.string().nullable().optional(),
});

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

    const state = createState();
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

    if (!validateState(state)) {
      return reply.status(400).send({ error: "Invalid or expired state" });
    }

    const tokenParams = new URLSearchParams({
      client_id: config.GITHUB_CLIENT_ID,
      client_secret: config.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });

    const tokenResponse = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: tokenParams.toString(),
      }
    );

    if (!tokenResponse.ok) {
      request.log.warn(
        { status: tokenResponse.status },
        "GitHub token exchange failed"
      );
      return reply.status(502).send({ error: "GitHub token exchange failed" });
    }

    const tokenJson = await tokenResponse.json();
    const tokenParse = githubAccessTokenResponseSchema.safeParse(tokenJson);
    if (!tokenParse.success || tokenParse.data.error || !tokenParse.data.access_token) {
      request.log.warn(
        { tokenResponse: tokenJson },
        "Invalid GitHub token response"
      );
      return reply.status(502).send({ error: "Invalid GitHub token response" });
    }

    const githubAccessToken = tokenParse.data.access_token;

    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${githubAccessToken}`,
        Accept: "application/json",
      },
    });

    if (!userResponse.ok) {
      request.log.warn(
        { status: userResponse.status },
        "GitHub user fetch failed"
      );
      return reply.status(502).send({ error: "GitHub user fetch failed" });
    }

    const userJson = await userResponse.json();
    const userParse = githubUserResponseSchema.safeParse(userJson);
    if (!userParse.success) {
      request.log.warn({ userResponse: userJson }, "Invalid GitHub user response");
      return reply.status(502).send({ error: "Invalid GitHub user response" });
    }

    const providerUserId = String(userParse.data.id);
    const providerUsername = userParse.data.login ?? null;
    const now = new Date();

    const existingOauthAccount = await oauthAccounts().findOne({
      provider: "github",
      providerUserId,
    });

    let userId: ObjectId;

    if (existingOauthAccount) {
      userId = existingOauthAccount.userId;
      await oauthAccounts().updateOne(
        { _id: existingOauthAccount._id },
        {
          $set: {
            accessToken: githubAccessToken,
            providerUsername,
            updatedAt: now,
          },
        }
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
        provider: "github",
        providerUserId,
        providerUsername,
        accessToken: githubAccessToken,
        refreshToken: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const accessToken = signAccessToken({
      userId: userId.toHexString(),
      provider: "github",
      providerUserId,
    });
    const refreshToken = signRefreshToken({ userId: userId.toHexString() });

    return {
      accessToken,
      refreshToken,
      user: {
        id: userId.toHexString(),
        provider: "github",
        providerUserId,
        providerUsername,
      },
    };
  });
};

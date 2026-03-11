import { z } from "zod";

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

export async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<{ accessToken: string }> {
  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: tokenParams.toString(),
  });

  if (!tokenResponse.ok) {
    throw new Error("GITHUB_TOKEN_EXCHANGE_FAILED");
  }

  const tokenJson = await tokenResponse.json();
  const tokenParse = githubAccessTokenResponseSchema.safeParse(tokenJson);
  if (!tokenParse.success || tokenParse.data.error || !tokenParse.data.access_token) {
    throw new Error("INVALID_GITHUB_TOKEN_RESPONSE");
  }

  return { accessToken: tokenParse.data.access_token };
}

export async function fetchUser(
  accessToken: string
): Promise<{ id: string; login: string | null }> {
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `token ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!userResponse.ok) {
    throw new Error("GITHUB_USER_FETCH_FAILED");
  }

  const userJson = await userResponse.json();
  const userParse = githubUserResponseSchema.safeParse(userJson);
  if (!userParse.success) {
    throw new Error("INVALID_GITHUB_USER_RESPONSE");
  }

  return {
    id: String(userParse.data.id),
    login: userParse.data.login ?? null,
  };
}

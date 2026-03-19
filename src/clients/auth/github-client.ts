import { z } from "zod";
import type { OAuthExchangeParams, OAuthIdentity, OAuthTokens } from "../../types/oauth.js";
import { BadGatewayError } from "../../lib/errors.js";
import { OAuthClient } from "./oauth-client.js";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
});

const userResponseSchema = z.object({
  id: z.number(),
  login: z.string().nullable().optional(),
});

export class GithubClient extends OAuthClient {
  protected readonly tokenEndpoint = "https://github.com/login/oauth/access_token";

  protected async exchangeCode(params: OAuthExchangeParams): Promise<OAuthTokens> {
    const json = await this.fetchTokenEndpoint(params, {
      headers: { Accept: "application/json" },
    });

    const result = tokenResponseSchema.safeParse(json);
    if (!result.success) {
      throw new BadGatewayError({ debugMessage: "INVALID_TOKEN_RESPONSE" });
    }

    return { token: result.data.access_token };
  }

  protected async resolveIdentity(tokens: OAuthTokens): Promise<OAuthIdentity> {
    const user = await this.#fetchUser(tokens.token);

    return {
      providerUserId: user.id,
      providerUsername: user.login,
    };
  }

  async #fetchUser(accessToken: string): Promise<{ id: string; login: string | null }> {
    const response = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${accessToken}`, Accept: "application/json" },
    });

    if (!response.ok) {
      throw new BadGatewayError({ debugMessage: "GITHUB_USER_FETCH_FAILED" });
    }

    const json = await response.json();
    const result = userResponseSchema.safeParse(json);
    if (!result.success) {
      throw new BadGatewayError({ debugMessage: "INVALID_GITHUB_USER_RESPONSE" });
    }

    return {
      id: String(result.data.id),
      login: result.data.login ?? null,
    };
  }
}

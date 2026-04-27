import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { OAuthExchangeParams, OAuthIdentity, OAuthTokens } from "../../types/oauth.js";
import { BadGatewayError } from "../../lib/errors.js";
import { OAuthClient } from "./oauth-client.js";

const tokenResponseSchema = z.object({
  id_token: z.string().min(1),
});

const idTokenPayloadSchema = z.object({
  iss: z.enum(["accounts.google.com", "https://accounts.google.com"]),
  aud: z.string().min(1),
  sub: z.string().min(1),
  name: z.string().optional(),
  given_name: z.string().optional(),
  email: z.string().email().optional(),
});

const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";

export class GoogleClient extends OAuthClient {
  protected readonly tokenEndpoint = "https://oauth2.googleapis.com/token";
  readonly #jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));

  protected async exchangeCode(params: OAuthExchangeParams): Promise<OAuthTokens> {
    const json = await this.fetchTokenEndpoint(params, {
      extraParams: { grant_type: "authorization_code" },
    });

    const result = tokenResponseSchema.safeParse(json);
    if (!result.success) {
      throw new BadGatewayError({ debugMessage: "INVALID_TOKEN_RESPONSE" });
    }

    return { token: result.data.id_token };
  }

  protected async resolveIdentity(tokens: OAuthTokens, params: OAuthExchangeParams): Promise<OAuthIdentity> {
    const user = await this.#verifyIdToken(tokens.token, params.clientId);

    return {
      providerUserId: user.sub,
      providerUsername: user.name ?? null,
      email: user.email ?? null,
    };
  }

  async #verifyIdToken(idToken: string, clientId: string): Promise<{ sub: string; name?: string; email?: string }> {
    const { payload } = await jwtVerify(idToken, this.#jwks, {
      issuer: ["accounts.google.com", "https://accounts.google.com"],
      audience: clientId,
    });

    const result = idTokenPayloadSchema.safeParse(payload);
    if (!result.success) {
      throw new BadGatewayError({ debugMessage: "INVALID_GOOGLE_ID_TOKEN_PAYLOAD" });
    }

    return {
      sub: result.data.sub,
      name: result.data.name ?? result.data.given_name,
      email: result.data.email,
    };
  }
}

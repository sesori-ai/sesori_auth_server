import { createRemoteJWKSet, jwtVerify } from "jose";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { OAuthExchangeParams, OAuthIdentity, OAuthTokens } from "../../types/oauth.js";
import { BadGatewayError } from "../../lib/errors.js";
import { OAuthClient } from "./oauth-client.js";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URI = "https://appleid.apple.com/auth/keys";

const tokenResponseSchema = z.object({
  id_token: z.string().min(1),
});

const idTokenPayloadSchema = z.object({
  iss: z.literal(APPLE_ISSUER),
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  sub: z.string().min(1),
  email: z.email().optional(),
  exp: z.number().int().positive(),
});

type AppleClientConfig = {
  teamId: string;
  keyId: string;
  privateKey: string;
};

export class AppleClient extends OAuthClient {
  protected readonly tokenEndpoint = "https://appleid.apple.com/auth/token";
  readonly #jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URI));
  readonly #teamId: string;
  readonly #keyId: string;
  readonly #privateKey: string;

  constructor(config: AppleClientConfig) {
    super();
    this.#teamId = config.teamId;
    this.#keyId = config.keyId;
    this.#privateKey = config.privateKey;
  }

  protected async exchangeCode(params: OAuthExchangeParams): Promise<OAuthTokens> {
    const clientSecret = this.#createClientSecret(params.clientId);
    const json = await this.fetchTokenEndpoint(params, {
      extraParams: {
        grant_type: "authorization_code",
        client_secret: clientSecret,
      },
    });

    const result = tokenResponseSchema.safeParse(json);
    if (!result.success) {
      throw new BadGatewayError({ debugMessage: "INVALID_TOKEN_RESPONSE" });
    }

    return { token: result.data.id_token };
  }

  protected async resolveIdentity(tokens: OAuthTokens, params: OAuthExchangeParams): Promise<OAuthIdentity> {
    const { payload } = await jwtVerify(tokens.token, this.#jwks, {
      issuer: APPLE_ISSUER,
      audience: params.clientId,
    });

    const result = idTokenPayloadSchema.safeParse(payload);
    if (!result.success) {
      throw new BadGatewayError({ debugMessage: "INVALID_APPLE_ID_TOKEN_PAYLOAD" });
    }

    return {
      providerUserId: result.data.sub,
      providerUsername: result.data.email ?? null,
    };
  }

  #createClientSecret(clientId: string): string {
    const now = Math.floor(Date.now() / 1000);

    return jwt.sign(
      {
        iss: this.#teamId,
        iat: now,
        exp: now + 180,
        aud: APPLE_ISSUER,
        sub: clientId,
      },
      this.#privateKey,
      {
        algorithm: "ES256",
        keyid: this.#keyId,
      },
    );
  }
}

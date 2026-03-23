import type { OAuthExchangeParams, OAuthIdentity, OAuthTokens } from "../../types/oauth.js";
import { BadGatewayError } from "../../lib/errors.js";

/**
 * Template method for OAuth2 authorization code flows.
 * authenticate() enforces the two-step sequence: exchangeCode → resolveIdentity.
 * Subclasses implement exchangeCode (provider-specific token retrieval + schema validation)
 * and resolveIdentity (normalize provider data into OAuthIdentity).
 * fetchTokenEndpoint provides the shared HTTP plumbing for the token exchange POST.
 */
export abstract class OAuthClient {
  protected abstract readonly tokenEndpoint: string;

  async authenticate(params: OAuthExchangeParams): Promise<OAuthIdentity> {
    const tokens = await this.exchangeCode(params);
    return this.resolveIdentity(tokens, params);
  }

  protected abstract exchangeCode(params: OAuthExchangeParams): Promise<OAuthTokens>;

  protected async fetchTokenEndpoint(
    params: OAuthExchangeParams,
    options?: { extraParams?: Record<string, string>; headers?: Record<string, string> },
  ): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      ...options?.extraParams,
    });

    const response = await fetch(this.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...options?.headers },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new BadGatewayError({ debugMessage: "TOKEN_EXCHANGE_FAILED" });
    }

    const json = await response.json();
    if (json.error) {
      throw new BadGatewayError({ debugMessage: `TOKEN_EXCHANGE_REJECTED: ${JSON.stringify(json.error)}` });
    }

    return json as Record<string, unknown>;
  }

  protected abstract resolveIdentity(tokens: OAuthTokens, params: OAuthExchangeParams): Promise<OAuthIdentity>;
}

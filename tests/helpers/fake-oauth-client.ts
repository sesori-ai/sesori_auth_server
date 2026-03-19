import { OAuthClient } from "../../src/clients/auth/oauth-client.js";
import type { OAuthExchangeParams, OAuthIdentity, OAuthTokens } from "../../src/types/oauth.js";

export class FakeOAuthClient extends OAuthClient {
  protected readonly tokenEndpoint = "http://fake";
  readonly #identity: OAuthIdentity;

  constructor(identity: OAuthIdentity) {
    super();
    this.#identity = identity;
  }

  protected async exchangeCode(_params: OAuthExchangeParams): Promise<OAuthTokens> {
    return { token: "fake-token" };
  }

  protected async resolveIdentity(_tokens: OAuthTokens, _params: OAuthExchangeParams): Promise<OAuthIdentity> {
    return this.#identity;
  }
}

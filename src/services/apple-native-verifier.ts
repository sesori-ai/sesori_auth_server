import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { BadGatewayError } from "../lib/errors.js";
import type { OAuthIdentity } from "../types/oauth.js";

const APPLE_JWKS_URI = "https://appleid.apple.com/auth/keys";

const appleIdTokenPayloadSchema = z.object({
  iss: z.literal("https://appleid.apple.com"),
  aud: z.string().min(1),
  sub: z.string().min(1),
  email: z.string().min(1).optional(),
  nonce: z.string().min(1).optional(),
});

export type AppleNativeVerifierConfig = {
  teamId: string;
  keyId: string;
  clientId: string;
  iosClientId: string;
  privateKey: string;
};

export class AppleNativeVerifier {
  readonly #config: AppleNativeVerifierConfig;
  readonly #jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URI));

  constructor(config: AppleNativeVerifierConfig) {
    this.#config = {
      ...config,
      privateKey: config.privateKey.replace(/\\n/g, "\n"),
    };
  }

  async verifyIdToken(idToken: string, clientId: string, nonce?: string): Promise<OAuthIdentity> {
    if (clientId !== this.#config.clientId && clientId !== this.#config.iosClientId) {
      throw new BadGatewayError({ debugMessage: "UNKNOWN_APPLE_CLIENT_ID" });
    }

    const { payload } = await jwtVerify(idToken, this.#jwks, {
      issuer: "https://appleid.apple.com",
      audience: clientId,
    });

    const result = appleIdTokenPayloadSchema.safeParse(payload);
    if (!result.success) {
      throw new BadGatewayError({
        debugMessage: "INVALID_APPLE_ID_TOKEN_PAYLOAD",
        nestedError: result.error.issues,
      });
    }

    if (nonce && result.data.nonce !== nonce) {
      throw new BadGatewayError({ debugMessage: "INVALID_APPLE_ID_TOKEN_NONCE" });
    }

    return {
      providerUserId: result.data.sub,
      providerUsername: result.data.email ?? null,
    };
  }
}

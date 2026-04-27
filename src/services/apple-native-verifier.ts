import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import { createHash, timingSafeEqual } from "crypto";
import { z } from "zod";
import { BadGatewayError, UnauthenticatedError } from "../lib/errors.js";
import type { OAuthIdentity } from "../types/oauth.js";

const APPLE_JWKS_URI = "https://appleid.apple.com/auth/keys";

const appleIdTokenPayloadSchema = z.object({
  iss: z.literal("https://appleid.apple.com"),
  aud: z.string().min(1),
  sub: z.string().min(1),
  email: z.string().min(1).optional(),
  nonce: z.string().min(1),
});

export type AppleNativeVerifierConfig = {
  clientId: string;
  iosClientId: string;
};

export class AppleNativeVerifier {
  readonly #config: AppleNativeVerifierConfig;
  readonly #jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URI));

  constructor(config: AppleNativeVerifierConfig) {
    this.#config = config;
  }

  async verifyIdToken(idToken: string, clientId: string, nonce: string): Promise<OAuthIdentity> {
    if (clientId !== this.#config.clientId && clientId !== this.#config.iosClientId) {
      throw new BadGatewayError({ debugMessage: "UNKNOWN_APPLE_CLIENT_ID" });
    }

    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(idToken, this.#jwks, {
        issuer: "https://appleid.apple.com",
        audience: clientId,
      });
      payload = result.payload;
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        throw new UnauthenticatedError({ debugMessage: "Apple ID token expired", nestedError: error });
      }
      if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
        throw new UnauthenticatedError({ debugMessage: "Apple ID token signature invalid", nestedError: error });
      }
      if (error instanceof joseErrors.JWTClaimValidationFailed) {
        throw new UnauthenticatedError({ debugMessage: "Apple ID token claim invalid", nestedError: error });
      }
      if (error instanceof joseErrors.JOSEError) {
        throw new UnauthenticatedError({ debugMessage: "Apple ID token invalid", nestedError: error });
      }
      throw new BadGatewayError({ debugMessage: "Apple ID token verification failed", nestedError: error });
    }

    const result = appleIdTokenPayloadSchema.safeParse(payload);
    if (!result.success) {
      throw new BadGatewayError({
        debugMessage: "INVALID_APPLE_ID_TOKEN_PAYLOAD",
        nestedError: result.error.issues,
      });
    }

    const hashedNonce = createHash("sha256").update(nonce).digest("hex");
    const tokenNonceBuf = Buffer.from(result.data.nonce, "utf-8");
    const expectedNonceBuf = Buffer.from(hashedNonce, "utf-8");
    if (tokenNonceBuf.length !== expectedNonceBuf.length) {
      throw new UnauthenticatedError({ debugMessage: "INVALID_APPLE_ID_TOKEN_NONCE" });
    }
    if (!timingSafeEqual(tokenNonceBuf, expectedNonceBuf)) {
      throw new UnauthenticatedError({ debugMessage: "INVALID_APPLE_ID_TOKEN_NONCE" });
    }

    return {
      providerUserId: result.data.sub,
      providerUsername: result.data.email ?? null,
      email: result.data.email ?? null,
    };
  }
}

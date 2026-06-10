import { z } from "zod";

export const accessTokenPayloadSchema = z.object({
  tokenType: z.literal("access"),
  userId: z.string(),
  provider: z.string(),
  providerUserId: z.string(),
  iss: z.literal("auth-backend"),
  aud: z.literal("mobile"),
  exp: z.number(),
  iat: z.number(),
});

export type AccessTokenPayload = z.infer<typeof accessTokenPayloadSchema>;

export const refreshTokenPayloadSchema = z.object({
  tokenType: z.literal("refresh"),
  userId: z.string(),
  /**
   * Monotonic counter mirrored from the User document and incremented by
   * logoutUser/revoke. POST /auth/refresh rejects refresh tokens whose
   * tokenVersion is older than the current User.tokenVersion, which is how
   * logout/revoke invalidates outstanding refresh tokens. Access tokens are
   * deliberately stateless and simply expire (15 min).
   */
  tokenVersion: z.number(),
  iss: z.literal("auth-backend"),
  aud: z.literal("mobile"),
  exp: z.number(),
  iat: z.number(),
});

export type RefreshTokenPayload = z.infer<typeof refreshTokenPayloadSchema>;

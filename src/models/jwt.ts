import { z } from "zod";

export const accessTokenPayloadSchema = z.object({
  userId: z.string(),
  provider: z.string(),
  providerUserId: z.string(),
  iss: z.string(),
  aud: z.string(),
  exp: z.number(),
  iat: z.number(),
});

export type AccessTokenPayload = z.infer<typeof accessTokenPayloadSchema>;

export const refreshTokenPayloadSchema = z.object({
  userId: z.string(),
  iss: z.string(),
  aud: z.string(),
  exp: z.number(),
  iat: z.number(),
});

export type RefreshTokenPayload = z.infer<typeof refreshTokenPayloadSchema>;

export const bridgeTokenPayloadSchema = z.object({
  userId: z.string(),
  iss: z.string(),
  aud: z.literal("bridge"),
  exp: z.number(),
  iat: z.number(),
});

export type BridgeTokenPayload = z.infer<typeof bridgeTokenPayloadSchema>;

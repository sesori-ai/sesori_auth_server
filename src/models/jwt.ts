import { z } from "zod";

export const accessTokenPayloadSchema = z.object({
  tokenType: z.literal("access"),
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
  tokenType: z.literal("refresh"),
  userId: z.string(),
  tokenVersion: z.number(),
  iss: z.string(),
  aud: z.string(),
  exp: z.number(),
  iat: z.number(),
});

export type RefreshTokenPayload = z.infer<typeof refreshTokenPayloadSchema>;

export const bridgeTokenPayloadSchema = z.object({
  tokenType: z.literal("bridge"),
  userId: z.string(),
  iss: z.string(),
  aud: z.literal("bridge"),
  exp: z.number(),
  iat: z.number(),
});

export type BridgeTokenPayload = z.infer<typeof bridgeTokenPayloadSchema>;

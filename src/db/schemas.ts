import { z } from "zod";
import { ObjectId } from "mongodb";

// User document schema
export const userSchema = z.object({
  _id: z.instanceof(ObjectId),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type User = z.infer<typeof userSchema>;

// OAuth account document schema
export const oauthAccountSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  provider: z.string(),
  providerUserId: z.string(),
  providerUsername: z.string().nullable(),
  accessToken: z.string().nullable(),
  refreshToken: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OAuthAccount = z.infer<typeof oauthAccountSchema>;

// Bridge registration document schema
export const bridgeRegistrationSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  relayUrl: z.string(),
  roomCode: z.string(),
  publicKey: z.string(),
  lastHeartbeat: z.date(),
  createdAt: z.date(),
});

export type BridgeRegistration = z.infer<typeof bridgeRegistrationSchema>;

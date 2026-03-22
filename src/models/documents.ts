import { ObjectId } from "mongodb";
import { z } from "zod";

export const userSchema = z.object({
  _id: z.instanceof(ObjectId),
  tokenVersion: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type User = z.infer<typeof userSchema>;

export const oauthAccountSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  provider: z.string(),
  providerUserId: z.string(),
  providerUsername: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OAuthAccount = z.infer<typeof oauthAccountSchema>;

export const glossaryEntrySchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  word: z.string(),
  createdAt: z.date(),
});

export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

export const dailyUsageSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  date: z.string(),
  transcriptionSeconds: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DailyUsage = z.infer<typeof dailyUsageSchema>;

export const deviceTokenSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  token: z.string(),
  platform: z.enum(["ios", "android"]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DeviceToken = z.infer<typeof deviceTokenSchema>;

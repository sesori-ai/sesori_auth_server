import { z } from "zod";

export enum DevicePlatform {
  ios = "ios",
  android = "android",
  macos = "macos",
  windows = "windows",
  linux = "linux",
}

export const devicePlatformSchema = z.enum(DevicePlatform);

// What a deviceTokens row's `token` holds. Each value is also the field name
// that carries it on POST /notifications/register-token.
export enum DeviceTokenKind {
  // FCM registration token from the deprecated firebase_messaging getToken API.
  // Released apps keep sending these, so they stay supported.
  RegistrationToken = "token",
  // Firebase Installation ID, delivered by firebase_messaging's onRegistered
  // after register(). Sent as an FCM `fid` message.
  InstallationId = "fid",
}

export const deviceTokenKindSchema = z.enum(DeviceTokenKind);

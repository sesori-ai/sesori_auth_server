import { z } from "zod";

export enum DevicePlatform {
  ios = "ios",
  android = "android",
  macos = "macos",
  windows = "windows",
  linux = "linux",
}

export const devicePlatformSchema = z.enum(DevicePlatform);

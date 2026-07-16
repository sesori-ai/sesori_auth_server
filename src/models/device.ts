import { z } from "zod";

export enum DevicePlatform {
  ios = "ios",
  android = "android",
  macos = "macos",
  windows = "windows",
  linux = "linux",
}

export const MOBILE_DEVICE_PLATFORMS: readonly DevicePlatform[] = [DevicePlatform.ios, DevicePlatform.android];

export function isMobileDevicePlatform(platform: DevicePlatform): boolean {
  return MOBILE_DEVICE_PLATFORMS.includes(platform);
}

export const devicePlatformSchema = z.enum(DevicePlatform);

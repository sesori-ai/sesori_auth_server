import { z } from "zod";

export enum BridgePlatform {
  macos = "macos",
  windows = "windows",
  linux = "linux",
}

export enum BridgeStatus {
  active = "active",
  inactive = "inactive",
}

export const bridgeIdSchema = z.string().regex(/^br_[A-Za-z0-9_-]{8,32}$/);
export const bridgePlatformSchema = z.enum(BridgePlatform);
export const bridgeStatusSchema = z.enum(BridgeStatus);

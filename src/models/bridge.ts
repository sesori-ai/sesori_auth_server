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

// Maps the relay wire vocabulary ("connected"/"disconnected") to the internal
// BridgeStatus enum. The wire format is a contract with the relay's
// POST /internal/bridge-status payload — keep the two in sync deliberately.
export function bridgeStatusFromWire(status: "connected" | "disconnected"): BridgeStatus {
  return status === "connected" ? BridgeStatus.active : BridgeStatus.inactive;
}

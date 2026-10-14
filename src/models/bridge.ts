import { z } from "zod";

export enum BridgePlatform {
  macos = "macos",
  windows = "windows",
  linux = "linux",
}

// Last relay-reported connectivity, also exposed as BridgeSummary.status.
// "inactive" covers BOTH "bridge reported disconnected" and "soft-revoked" —
// disambiguate via the document's revokedAt field (summaries only list
// non-revoked bridges).
export enum BridgeStatus {
  active = "active",
  inactive = "inactive",
}

export enum BridgeConnectionNotificationPolicy {
  Normal = "normal",
  Suppress = "suppress",
  Conservative = "conservative",
}

export enum BridgeStatusEvent {
  NotificationPolicy = "notification_policy",
  ConnectionObserved = "connection_observed",
}

export const bridgeIdSchema = z.string().regex(/^br_[A-Za-z0-9_-]{8,32}$/);
// sha256 hex digest the bridge derives from the OS machine identifier, so a
// reinstall on the same computer reuses its bridge entry.
export const bridgeHostKeySchema = z.string().regex(/^[0-9a-f]{64}$/);
export const bridgePlatformSchema = z.enum(BridgePlatform);
export const bridgeStatusSchema = z.enum(BridgeStatus);

// Maps the relay wire vocabulary ("connected"/"disconnected") to the internal
// BridgeStatus enum. The wire format is a contract with the relay's
// POST /internal/bridge-status payload — keep the two in sync deliberately.
export function bridgeStatusFromWire(status: "connected" | "disconnected"): BridgeStatus {
  return status === "connected" ? BridgeStatus.active : BridgeStatus.inactive;
}

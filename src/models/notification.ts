import type { NotificationSettingKey } from "./settings.js";

// Values are the wire contract shared with the client's NotificationCategory
// enum; the bridge sends them verbatim on POST /notifications/send.
export enum NotificationCategory {
  AiInteraction = "ai_interaction",
  SessionMessage = "session_message",
  ConnectionStatus = "connection_status",
  SystemUpdate = "system_update",
}

// Typing as Record<NotificationCategory, …> keeps this exhaustive: a new
// category cannot compile until it is mapped to a toggle that can silence it.
export const NOTIFICATION_CATEGORY_SETTING_KEYS: Record<NotificationCategory, NotificationSettingKey> = {
  [NotificationCategory.AiInteraction]: "aiInteraction",
  [NotificationCategory.SessionMessage]: "sessionMessage",
  [NotificationCategory.ConnectionStatus]: "connectionStatus",
  [NotificationCategory.SystemUpdate]: "systemUpdate",
};

// Only these may arrive from a client; connection_status is server-originated.
export const CLIENT_SENDABLE_NOTIFICATION_CATEGORIES = [
  NotificationCategory.AiInteraction,
  NotificationCategory.SessionMessage,
  NotificationCategory.SystemUpdate,
] as const;

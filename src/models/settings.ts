import { z } from "zod";

// Full notification-settings shape: every known toggle, all required. This is
// the resolved contract GET returns and the source for the strict API patch
// schema. Keys mirror the client's NotificationCategory enum (aiInteraction, …).
export const notificationSettingsSchema = z.strictObject({
  aiInteraction: z.boolean(),
  sessionMessage: z.boolean(),
  connectionStatus: z.boolean(),
  systemUpdate: z.boolean(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export type NotificationSettingKey = keyof NotificationSettings;

// Server owns every default. The client treats an absent preference as enabled,
// so defaults are `true`; typing as Record<NotificationSettingKey, boolean>
// forces this map to stay exhaustive when a toggle is added to the schema above.
export const NOTIFICATION_SETTINGS_DEFAULTS: Record<NotificationSettingKey, boolean> = {
  aiInteraction: true,
  sessionMessage: true,
  connectionStatus: true,
  systemUpdate: true,
};

export const NOTIFICATION_SETTING_KEYS = Object.keys(NOTIFICATION_SETTINGS_DEFAULTS) as NotificationSettingKey[];

// Sparse view of the toggles: what a device has explicitly chosen, and what a
// PATCH may carry. `.partial()` keeps the strict mode, so unknown keys are still
// rejected — only known toggles may be persisted or updated.
export const notificationSettingsPatchSchema = notificationSettingsSchema.partial();
export type NotificationSettingsPatch = z.infer<typeof notificationSettingsPatchSchema>;

// Database reads accept retired keys so an old sparse document remains readable
// after a toggle leaves the public registry. Values stay boolean at the storage
// boundary; resolveNotificationSettings emits only currently supported keys.
export const storedNotificationSettingsSchema = z.record(z.string(), z.boolean());
export type StoredNotificationSettings = z.infer<typeof storedNotificationSettingsSchema>;

// Untrusted, client-generated device identifier. Normalized to lowercase, then
// pinned to the canonical UUIDv4 shape: 122 random bits make it
// non-enumerable, and settings are always additionally scoped by the caller's
// userId so a leaked deviceId still cannot cross accounts.
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const deviceIdSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().regex(UUID_V4_REGEX, "deviceId must be a UUIDv4"));
export type DeviceId = z.infer<typeof deviceIdSchema>;

// PATCH body: every group optional, but at least one leaf toggle must be present
// so a request always changes something. `.some` over the groups keeps the rule
// correct as future setting groups are added beside `notifications`.
export const updateSettingsBodySchema = z
  .strictObject({
    notifications: notificationSettingsPatchSchema.optional(),
  })
  .refine(
    (body) =>
      Object.values(body).some(
        (group) => group !== undefined && Object.values(group).some((value) => value !== undefined),
      ),
    { message: "At least one setting must be provided" },
  );
export type UpdateSettingsBody = z.infer<typeof updateSettingsBodySchema>;

export type SettingsConfigurationView = {
  deviceId: string;
  notifications: NotificationSettings;
  updatedAt: string | null;
};

// Merge a device's stored (sparse) toggles over the server defaults. Missing
// keys fall back to their default and keys no longer in the registry are
// dropped, so records that predate a schema change resolve without migration.
export function resolveNotificationSettings(
  stored: StoredNotificationSettings | undefined | null,
): NotificationSettings {
  const resolved = { ...NOTIFICATION_SETTINGS_DEFAULTS };
  if (!stored) {
    return resolved;
  }

  for (const key of NOTIFICATION_SETTING_KEYS) {
    const value = stored[key];
    if (typeof value === "boolean") {
      resolved[key] = value;
    }
  }

  return resolved;
}

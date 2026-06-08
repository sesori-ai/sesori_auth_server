import { z } from "zod";

const appleConfigSchema = z.object({
  APPLE_CLIENT_ID: z.string().min(1, "APPLE_CLIENT_ID is required"),
  APPLE_IOS_CLIENT_ID: z.string().min(1, "APPLE_IOS_CLIENT_ID is required"),
  APPLE_TEAM_ID: z.string().min(1, "APPLE_TEAM_ID is required"),
  APPLE_KEY_ID: z.string().min(1, "APPLE_KEY_ID is required"),
  APPLE_PRIVATE_KEY: z.string().min(1, "APPLE_PRIVATE_KEY is required"),
});

const configSchema = z.object({
  PORT: z.coerce.number().default(3001),
  // Public base URL of this auth service. Used to construct the redirect_uri
  // passed to OAuth providers (GitHub/Google/Apple) in the pending-confirmation
  // flow. MUST EXACTLY match the URI registered in each provider's OAuth app
  // config — mismatches cause `redirect_uri_mismatch` at the provider before
  // any code reaches us. The default targets production; staging/dev should
  // override explicitly via env.
  AUTH_BASE_URL: z.string().url().default("https://api.sesori.com"),
  // Maximum concurrent pending OAuth sessions held in-memory by
  // `PendingAuthStore`. Each entry is ~1 KB; default 10k ≈ 10 MB worst case.
  // Raise only if traffic warrants it AND single-instance memory allows.
  PENDING_AUTH_MAX_SESSIONS: z.coerce.number().int().positive().default(10_000),
  // Max long-poll duration on `GET /auth/session/status`. Lower values reduce
  // FD pressure under load; higher values reduce client-side reconnects.
  PENDING_AUTH_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  JWT_PRIVATE_KEY: z.string().min(1, "JWT_PRIVATE_KEY is required"),
  JWT_PUBLIC_KEY: z.string().min(1, "JWT_PUBLIC_KEY is required"),
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required"),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required"),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  ...appleConfigSchema.shape,
  ALLOWED_REDIRECT_URIS: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(z.string().min(1)).min(1)),
  RELAY_URL: z.string().min(1, "RELAY_URL is required"),
  RELAY_WEBHOOK_SECRET: z.string().optional(),
  // Transition gate for per-bridge-instance tracking. When true, the
  // /internal/bridge-status endpoint requires a bridgeId field; bridges that
  // don't send one are rejected with 400. Flip to true once the relay fleet
  // and the bridge CLI have rolled over (companion to RELAY_REQUIRE_BRIDGE_ID
  // on the relay).
  AUTH_REQUIRE_BRIDGE_ID_IN_STATUS: z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_TRANSCRIPTION_MODEL: z.string().min(1).default("gpt-4o-mini-transcribe"),
  OPENAI_METADATA_MODEL: z.string().min(1).default("gpt-5-nano"),
  FCM_SA_JSON: z
    .string()
    .min(1, "FCM_SA_JSON is required")
    .transform((val) => JSON.parse(Buffer.from(val, "base64").toString("utf-8")))
    .pipe(
      z.object({
        type: z.literal("service_account"),
        project_id: z.string().min(1),
        private_key_id: z.string().min(1),
        private_key: z.string().startsWith("-----BEGIN"),
        client_email: z.string().email(),
        client_id: z.string().min(1),
        auth_uri: z.string().url(),
        token_uri: z.string().url(),
        auth_provider_x509_cert_url: z.string().url(),
        client_x509_cert_url: z.string().url(),
        universe_domain: z.string().min(1),
      }),
    ),

  // App-wide limits (hardcoded defaults, not sourced from env)
  DAILY_TRANSCRIPTION_LIMIT_SECONDS: z.coerce.number().default(3600),
});

export type Config = z.infer<typeof configSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  try {
    cached = configSchema.parse(process.env);
    return cached;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.issues.map((err) => `${err.path.join(".")}: ${err.message}`).join("\n");
      console.error("Configuration validation failed:\n" + missingVars);
      process.exit(1);
    }
    throw error;
  }
}

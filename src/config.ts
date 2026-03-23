import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().default(3001),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  JWT_PRIVATE_KEY: z.string().min(1, "JWT_PRIVATE_KEY is required"),
  JWT_PUBLIC_KEY: z.string().min(1, "JWT_PUBLIC_KEY is required"),
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required"),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required"),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  ALLOWED_REDIRECT_URIS: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(z.string().min(1)).min(1)),
  RELAY_URL: z.string().min(1, "RELAY_URL is required"),
  RELAY_WEBHOOK_SECRET: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_TRANSCRIPTION_MODEL: z.string().min(1).default("gpt-4o-mini-transcribe"),
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

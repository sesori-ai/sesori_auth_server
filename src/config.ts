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
  RELAY_URL: z.string().min(1, "RELAY_URL is required"),
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
      const missingVars = error.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join("\n");
      console.error("Configuration validation failed:\n" + missingVars);
      process.exit(1);
    }
    throw error;
  }
}

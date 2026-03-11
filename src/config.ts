import { z } from "zod";

const configSchema = z
  .object({
    PORT: z.coerce.number().default(3001),
    MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
    JWT_PRIVATE_KEY: z.string().optional(),
    JWT_PUBLIC_KEY: z.string().optional(),
    JWT_PRIVATE_KEY_PATH: z.string().optional(),
    JWT_PUBLIC_KEY_PATH: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required"),
    GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required"),
    GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
    GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
    RELAY_URL: z.string().min(1, "RELAY_URL is required"),
  })
  .refine(
    (c) => (c.JWT_PRIVATE_KEY && c.JWT_PUBLIC_KEY) || (c.JWT_PRIVATE_KEY_PATH && c.JWT_PUBLIC_KEY_PATH),
    { message: "Provide either JWT_PRIVATE_KEY + JWT_PUBLIC_KEY (inline PEM) or JWT_PRIVATE_KEY_PATH + JWT_PUBLIC_KEY_PATH (file paths)" }
  );

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  try {
    return configSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.errors
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      console.error("Configuration validation failed:\n" + missingVars);
      process.exit(1);
    }
    throw error;
  }
}

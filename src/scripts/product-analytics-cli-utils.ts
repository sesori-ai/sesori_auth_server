import type { ZodError } from "zod";

export function productAnalyticsConfigurationError(input: { description: string; error: ZodError }): Error {
  const invalidFields = [
    ...new Set(input.error.issues.map((issue) => issue.path.join(".")).filter((field) => field !== "")),
  ].sort();
  const details = invalidFields.length === 0 ? "unknown field" : invalidFields.join(", ");
  return new Error(`Invalid ${input.description} configuration: ${details}`);
}

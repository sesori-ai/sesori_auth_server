import type { ZodError } from "zod";

const MAX_DIAGNOSTIC_ISSUES = 8;
const MAX_DIAGNOSTIC_PATH_SEGMENTS = 8;
const REDACTED_FIELD = "<field>";

export type ValidationDiagnosticIssue = {
  path: Array<string | number>;
  code: string;
};

export type ValidationDiagnostics = {
  issues: ValidationDiagnosticIssue[];
  truncated: boolean;
};

export function toValidationDiagnostics(error: ZodError, allowedFields: ReadonlySet<string>): ValidationDiagnostics {
  return {
    issues: error.issues.slice(0, MAX_DIAGNOSTIC_ISSUES).map((issue) => ({
      path: issue.path.slice(0, MAX_DIAGNOSTIC_PATH_SEGMENTS).map((segment) => {
        if (typeof segment === "string" && allowedFields.has(segment)) {
          return segment;
        }

        if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
          return segment;
        }

        return REDACTED_FIELD;
      }),
      code: issue.code,
    })),
    truncated:
      error.issues.length > MAX_DIAGNOSTIC_ISSUES ||
      error.issues.some((issue) => issue.path.length > MAX_DIAGNOSTIC_PATH_SEGMENTS),
  };
}

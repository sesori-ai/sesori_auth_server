import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z, type ZodError, type ZodType } from "zod";
import { toValidationDiagnostics } from "../../src/lib/validation-diagnostics.js";

describe("toValidationDiagnostics", () => {
  it("keeps only allowlisted fields and indices without exposing input details", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const schema = z.unknown().superRefine((_value, context) => {
      context.addIssue({
        code: "custom",
        path: ["words", 0, max, -1, 1.5, max + 1, Symbol("symbol-segment-secret"), "dynamic-field-secret"],
        message: "message-value-secret",
        params: { input: "input-value-secret", value: "raw-value-secret" },
      });
    });

    const pathDiagnostics = toValidationDiagnostics(getZodError(schema, "submitted-input-secret"), new Set(["words"]));

    assert.deepEqual(pathDiagnostics, {
      issues: [
        {
          path: ["words", 0, max, "<field>", "<field>", "<field>", "<field>", "<field>"],
          code: "custom",
        },
      ],
      truncated: false,
    });
    const shapeDiagnostics = toValidationDiagnostics(
      getZodError(z.object({ words: z.record(z.string(), z.number()) }).strict(), {
        words: { "dynamic-record-key-secret": "submitted-value-secret" },
        "unknown-key-secret": true,
      }),
      new Set(["words"]),
    );

    assert.deepEqual(shapeDiagnostics, {
      issues: [
        { path: ["words", "<field>"], code: "invalid_type" },
        { path: [], code: "unrecognized_keys" },
      ],
      truncated: false,
    });
    assert.doesNotMatch(JSON.stringify([pathDiagnostics, shapeDiagnostics]), /secret/);
  });

  it("bounds both issue count and path depth and marks truncation", () => {
    const schema = z.unknown().superRefine((_value, context) => {
      for (let index = 0; index < 9; index += 1) {
        context.addIssue({
          code: "custom",
          path: index === 0 ? [0, 1, 2, 3, 4, 5, 6, 7, "omitted-path-secret"] : [index],
          message: index === 8 ? "omitted-issue-value-secret" : "invalid",
        });
      }
    });

    const diagnostics = toValidationDiagnostics(getZodError(schema, null), new Set());

    assert.equal(diagnostics.issues.length, 8);
    assert.deepEqual(diagnostics.issues[0].path, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(diagnostics.truncated, true);
    assert.doesNotMatch(JSON.stringify(diagnostics), /omitted-(?:issue|path)/);
  });
});

function getZodError(schema: ZodType, value: unknown): ZodError {
  const result = schema.safeParse(value);
  if (result.success) {
    throw new Error("Expected schema validation to fail");
  }

  return result.error;
}

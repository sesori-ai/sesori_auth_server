import { createHash, createHmac } from "node:crypto";
import { InternalServerError } from "./errors.js";

const accountIdPattern = /^[a-fA-F0-9]{24}$/;

export function copyProductAnalyticsPseudonymizationKey(input: { value: Uint8Array }): Buffer {
  if (input.value.byteLength < 32) {
    throw new InternalServerError({ debugMessage: "Invalid product analytics pseudonymization key" });
  }
  return Buffer.from(input.value);
}

/**
 * Sole account pseudonymization point for analytics. The resulting HMAC is the
 * stable cross-table identity used by auth milestones, client events, and
 * deletion targets. Lowercase ObjectId canonicalization is load-bearing.
 */
export function productAnalyticsUserKeyFor(input: { userId: string; pseudonymizationKey: Uint8Array }): string {
  if (!accountIdPattern.test(input.userId) || input.pseudonymizationKey.byteLength < 32) {
    throw new InternalServerError({ debugMessage: "Invalid product analytics user-key input" });
  }

  const canonicalUserId = input.userId.toLowerCase();
  return createHmac("sha256", input.pseudonymizationKey).update(canonicalUserId, "utf8").digest("hex");
}

/**
 * Reproduces the pre-HMAC Firebase global user ID solely for restricted legacy
 * GA deletion requests. Never use this enumerable value for new analytics rows.
 */
export function legacyFirebaseAnalyticsUserIdFor(input: { userId: string }): string {
  if (!accountIdPattern.test(input.userId)) {
    throw new InternalServerError({ debugMessage: "Invalid legacy product analytics user ID input" });
  }
  return createHash("sha256").update(input.userId.toLowerCase(), "utf8").digest("hex");
}

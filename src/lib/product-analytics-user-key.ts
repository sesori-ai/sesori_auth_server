import { createHash } from "node:crypto";
import { InternalServerError } from "./errors.js";

const accountIdPattern = /^[a-fA-F0-9]{24}$/;

export function productAnalyticsUserKeyFor(input: { userId: string }): string {
  if (!accountIdPattern.test(input.userId)) {
    throw new InternalServerError({ debugMessage: "Invalid product analytics user ID for hashing" });
  }
  const canonicalUserId = input.userId.toLowerCase();
  return createHash("sha256").update(canonicalUserId, "utf8").digest("hex");
}

import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { InternalServerError } from "./errors.js";

export function productAnalyticsUserKeyFor(input: { userId: string }): string {
  if (!ObjectId.isValid(input.userId)) {
    throw new InternalServerError({ debugMessage: "Invalid product analytics user ID for hashing" });
  }
  const canonicalUserId = new ObjectId(input.userId).toHexString();
  return createHash("sha256").update(canonicalUserId, "utf8").digest("hex");
}

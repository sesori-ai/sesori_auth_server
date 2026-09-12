import { createHmac } from "node:crypto";
import { z } from "zod";
import { InternalServerError } from "./errors.js";
import { type OptionalEmailAddressKey, OptionalEmailAddressKeyVersion } from "../types/optional-email.js";

const normalizedOptionalEmailAddressSchema = z
  .string()
  .trim()
  .email()
  .transform((value) => value.toLowerCase());

const OPTIONAL_EMAIL_ADDRESS_KEY_PURPOSE = "optional_email_address_suppression";
export const OPTIONAL_EMAIL_ADDRESS_KEY_SECRET_MIN_BYTES = 32;

export function normalizeOptionalEmailAddress(input: { address: unknown }): string | null {
  const parsed = normalizedOptionalEmailAddressSchema.safeParse(input.address);
  return parsed.success ? parsed.data : null;
}

/**
 * Derives a purpose- and version-separated key from the same conservative
 * normalization used by recipient resolution. Rotating the secret requires a
 * new version; suppression checks must derive every retained version.
 */
export function deriveOptionalEmailAddressKey(input: {
  address: string;
  secret: string;
  version: OptionalEmailAddressKeyVersion;
}): OptionalEmailAddressKey {
  const normalizedAddress = normalizeOptionalEmailAddress({ address: input.address });
  if (!Object.values(OptionalEmailAddressKeyVersion).includes(input.version)) {
    throw new InternalServerError({ debugMessage: "Invalid optional email address-key version" });
  }
  if (normalizedAddress === null) {
    throw new InternalServerError({ debugMessage: "Invalid optional email address-key address" });
  }
  if (Buffer.byteLength(input.secret, "utf8") < OPTIONAL_EMAIL_ADDRESS_KEY_SECRET_MIN_BYTES) {
    throw new InternalServerError({ debugMessage: "Invalid optional email address-key secret" });
  }

  const message = `${OPTIONAL_EMAIL_ADDRESS_KEY_PURPOSE}\0${input.version}\0${normalizedAddress}`;
  return {
    addressKeyVersion: input.version,
    addressKey: createHmac("sha256", input.secret).update(message, "utf8").digest("hex"),
  };
}

import { isIP } from "node:net";
import { z } from "zod";

export enum ClientIpSource {
  Socket = "socket",
  Cloudflare = "cloudflare",
}

export const clientIpSourceSchema = z.enum(ClientIpSource);

function isTrustedIngressEntry(entry: string): boolean {
  const [address, prefix, ...extra] = entry.split("/");
  if (extra.length > 0 || address === undefined) {
    return false;
  }

  const family = isIP(address);
  if (family === 0) {
    return false;
  }

  if (prefix === undefined) {
    return true;
  }

  // Rejects "10.0.0.0/", "/8", "0x8" and "+8" before Number() coerces them, and
  // leading zeros. A zero prefix is excluded because @fastify/proxy-addr refuses
  // range <= 0, so "0.0.0.0/0" would otherwise pass here and throw at boot.
  if (!/^[1-9][0-9]*$/.test(prefix)) {
    return false;
  }

  return Number(prefix) <= (family === 4 ? 32 : 128);
}

// Validated here rather than at first use: @fastify/proxy-addr compiles these
// eagerly when the app boots, and a typo would otherwise surface as
// "TypeError: invalid range on address" from deep inside ipaddr.js.
export const trustedIngressCidrsSchema = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }

    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return entries.length > 0 ? entries : undefined;
  })
  .refine(
    (entries) => entries === undefined || entries.every(isTrustedIngressEntry),
    "must be a comma-separated list of IPv4/IPv6 addresses or CIDR ranges",
  );

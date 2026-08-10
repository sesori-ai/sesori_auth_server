import { isIP } from "node:net";
import proxyaddr from "@fastify/proxy-addr";
import type { FastifyRequest } from "fastify";
import { ClientIpSource } from "../types/client-ip.js";

type TrustPredicate = (addr: string, i: number) => boolean;

export type ClientIpResolverConfig = {
  readonly source: ClientIpSource;
  readonly cloudflareIngressCidrs?: string;
};

export type ClientIpRequest = Pick<FastifyRequest, "headers" | "ip">;

function parseIngressCidrs(rawCidrs: string | undefined): readonly string[] | undefined {
  if (rawCidrs === undefined) {
    return undefined;
  }

  const cidrs = rawCidrs
    .split(",")
    .map((cidr) => cidr.trim())
    .filter((cidr) => cidr.length > 0);

  if (cidrs.length === 0) {
    return undefined;
  }

  return cidrs;
}

function readSingleHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  if (value.length === 0 || value.includes(",") || isIP(value) === 0) {
    return undefined;
  }

  return value;
}

function buildIngressTrust(rawCidrs: string | undefined): TrustPredicate | undefined {
  const cidrs = parseIngressCidrs(rawCidrs);
  if (cidrs === undefined) {
    return undefined;
  }

  return proxyaddr.compile([...cidrs]);
}

const LOOPBACK_SOCKET_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// @fastify/rate-limit matches an array allowList against the *generated key*,
// not the socket address. In cloudflare mode the key can come from a header, so
// an array of loopback literals would let a forged `CF-Connecting-IP: 127.0.0.1`
// match the allowlist and skip rate limiting entirely. The exemption is a
// property of the connection, so it must be evaluated against request.ip.
export function isLoopbackSocket(request: ClientIpRequest): boolean {
  return LOOPBACK_SOCKET_ADDRESSES.has(request.ip);
}

export function createClientIpResolver(config: ClientIpResolverConfig): (request: ClientIpRequest) => string {
  switch (config.source) {
    case ClientIpSource.Socket:
      return (request) => request.ip;
    case ClientIpSource.Cloudflare: {
      const ingressTrust = buildIngressTrust(config.cloudflareIngressCidrs);

      return (request) => {
        if (ingressTrust !== undefined && !ingressTrust(request.ip, 0)) {
          return request.ip;
        }

        return readSingleHeaderValue(request.headers["cf-connecting-ip"]) ?? request.ip;
      };
    }
  }
}

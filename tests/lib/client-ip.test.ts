import assert from "node:assert/strict";
import { describe, it } from "node:test";
import proxyaddr from "@fastify/proxy-addr";
import { createClientIpResolver, isLoopbackSocket, type ClientIpRequest } from "../../src/lib/client-ip.js";
import { ClientIpSource, trustedIngressCidrsSchema } from "../../src/types/client-ip.js";

function request(headers: ClientIpRequest["headers"], ip = "198.51.100.10"): ClientIpRequest {
  return { headers, ip };
}

describe("createClientIpResolver", () => {
  it("returns the socket address when source is socket", () => {
    const resolveClientIp = createClientIpResolver({ source: ClientIpSource.Socket });

    const resolved = resolveClientIp(request({ "cf-connecting-ip": "203.0.113.10" }));

    assert.equal(resolved, "198.51.100.10");
  });

  it("returns CF-Connecting-IP in cloudflare mode when the header is exactly one IP", () => {
    const resolveClientIp = createClientIpResolver({ source: ClientIpSource.Cloudflare });

    const resolved = resolveClientIp(request({ "cf-connecting-ip": "203.0.113.10" }));

    assert.equal(resolved, "203.0.113.10");
  });

  it("falls back to the socket address when the Cloudflare header is missing or invalid", () => {
    const resolveClientIp = createClientIpResolver({ source: ClientIpSource.Cloudflare });

    assert.equal(resolveClientIp(request({})), "198.51.100.10");
    assert.equal(resolveClientIp(request({ "cf-connecting-ip": "" })), "198.51.100.10");
    assert.equal(resolveClientIp(request({ "cf-connecting-ip": "203.0.113.10, 198.51.100.9" })), "198.51.100.10");
    assert.equal(resolveClientIp(request({ "cf-connecting-ip": "not-an-ip" })), "198.51.100.10");
    assert.equal(resolveClientIp(request({ "cf-connecting-ip": ["203.0.113.10"] })), "198.51.100.10");
  });

  it("honors CF-Connecting-IP only when the socket peer matches configured ingress CIDRs", () => {
    const resolveClientIp = createClientIpResolver({
      source: ClientIpSource.Cloudflare,
      cloudflareIngressCidrs: ["198.51.100.0/24", "2001:db8:abcd::/48"],
    });

    assert.equal(resolveClientIp(request({ "cf-connecting-ip": "203.0.113.10" }, "198.51.100.99")), "203.0.113.10");
    assert.equal(resolveClientIp(request({ "cf-connecting-ip": "203.0.113.10" }, "198.51.101.99")), "198.51.101.99");
    assert.equal(
      resolveClientIp(request({ "cf-connecting-ip": "2001:db8::1234" }, "2001:db8:abcd::1")),
      "2001:db8::1234",
    );
  });
});

// The point of validating the ingress list in the schema is that a bad value
// fails startup with a clear message instead of throwing from ipaddr.js when
// proxy-addr compiles it during buildApp. That only holds if the schema never
// accepts something proxy-addr rejects, so assert the two agree directly rather
// than trusting a hand-maintained list of bad inputs to stay in sync.
describe("trustedIngressCidrsSchema", () => {
  it("never accepts a value that proxy-addr would reject at boot", () => {
    const candidates = [
      "0.0.0.0/0",
      "::/0",
      "198.51.100.0/1",
      "198.51.100.0/24",
      "198.51.100.0/32",
      "198.51.100.0/33",
      "2001:db8::/1",
      "2001:db8::/128",
      "2001:db8::/129",
      "203.0.113.7",
      "::1",
      "::ffff:127.0.0.1",
      "not-an-ip",
      "198.51.100.0/",
      "198.51.100.0/08",
      "198.51.100.0/0x8",
      "173.245.48.0/20, 2400:cb00::/32",
    ];

    for (const candidate of candidates) {
      const parsed = trustedIngressCidrsSchema.safeParse(candidate);
      if (!parsed.success || parsed.data === undefined) {
        continue;
      }

      const entries = [...parsed.data];

      assert.doesNotThrow(
        () => proxyaddr.compile(entries),
        `schema accepted ${JSON.stringify(candidate)} but proxy-addr rejects it, which would crash buildApp`,
      );
    }
  });
});

describe("isLoopbackSocket", () => {
  it("recognises loopback socket addresses including the IPv4-mapped form", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(isLoopbackSocket(request({}, ip)), true, `${ip} should be loopback`);
    }
  });

  it("never treats a routable peer as loopback regardless of headers", () => {
    assert.equal(isLoopbackSocket(request({ "cf-connecting-ip": "127.0.0.1" }, "203.0.113.99")), false);
  });
});

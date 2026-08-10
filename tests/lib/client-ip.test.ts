import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClientIpResolver, isLoopbackSocket, type ClientIpRequest } from "../../src/lib/client-ip.js";
import { ClientIpSource } from "../../src/types/client-ip.js";

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
      cloudflareIngressCidrs: "198.51.100.0/24, 2001:db8:abcd::/48",
    });

    assert.equal(resolveClientIp(request({ "cf-connecting-ip": "203.0.113.10" }, "198.51.100.99")), "203.0.113.10");
    assert.equal(resolveClientIp(request({ "cf-connecting-ip": "203.0.113.10" }, "198.51.101.99")), "198.51.101.99");
    assert.equal(
      resolveClientIp(request({ "cf-connecting-ip": "2001:db8::1234" }, "2001:db8:abcd::1")),
      "2001:db8::1234",
    );
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

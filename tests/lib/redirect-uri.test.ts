import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAllowedRedirectUri } from "../../src/lib/redirect-uri.js";

const ALLOWED = ["myapp://oauth/callback"];

describe("isAllowedRedirectUri", () => {
  it("allows a URI that is in the allow-list", () => {
    assert.equal(isAllowedRedirectUri("myapp://oauth/callback", ALLOWED), true);
  });

  it("rejects a URI that is not in the allow-list and not localhost", () => {
    assert.equal(isAllowedRedirectUri("https://evil.com/callback", ALLOWED), false);
  });

  it("allows http://localhost redirect", () => {
    assert.equal(isAllowedRedirectUri("http://localhost:3000/callback", ALLOWED), true);
  });

  it("allows http://localhost without port", () => {
    assert.equal(isAllowedRedirectUri("http://localhost/callback", ALLOWED), true);
  });

  it("allows http://127.0.0.1 redirect", () => {
    assert.equal(isAllowedRedirectUri("http://127.0.0.1:8080/callback", ALLOWED), true);
  });

  it("allows http://127.0.0.1 without port", () => {
    assert.equal(isAllowedRedirectUri("http://127.0.0.1/callback", ALLOWED), true);
  });

  it("allows http://[::1] redirect", () => {
    assert.equal(isAllowedRedirectUri("http://[::1]:3000/callback", ALLOWED), true);
  });

  it("allows http://[::1] without port", () => {
    assert.equal(isAllowedRedirectUri("http://[::1]/callback", ALLOWED), true);
  });

  it("rejects an invalid URI that is not in the allow-list", () => {
    assert.equal(isAllowedRedirectUri("not-a-valid-url", ALLOWED), false);
  });

  it("rejects a remote host even if it contains 'localhost' in the path", () => {
    assert.equal(isAllowedRedirectUri("https://evil.com/localhost", ALLOWED), false);
  });

  it("rejects a subdomain of localhost", () => {
    assert.equal(isAllowedRedirectUri("http://sub.localhost:3000/callback", ALLOWED), false);
  });

  it("allows with an empty allow-list if URI is localhost", () => {
    assert.equal(isAllowedRedirectUri("http://localhost:3000/callback", []), true);
  });

  it("rejects with an empty allow-list if URI is not localhost", () => {
    assert.equal(isAllowedRedirectUri("https://example.com/callback", []), false);
  });
});

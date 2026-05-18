import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProviderCallbackRedirectUri, parseSessionTokenHeader } from "../../src/routes/auth/init.js";
import { OAuthProviderName } from "../../src/types/oauth.js";

const HEX_TOKEN_LOWER = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HEX_TOKEN_UPPER = HEX_TOKEN_LOWER.toUpperCase();

describe("parseSessionTokenHeader", () => {
  it("canonicalizes uppercase hex to lowercase so digests match (codex-2a852c8)", () => {
    assert.equal(parseSessionTokenHeader(HEX_TOKEN_UPPER), HEX_TOKEN_LOWER);
    assert.equal(parseSessionTokenHeader(HEX_TOKEN_LOWER), HEX_TOKEN_LOWER);
  });

  it("returns the first value of a multi-value header", () => {
    assert.equal(parseSessionTokenHeader([HEX_TOKEN_UPPER, HEX_TOKEN_LOWER]), HEX_TOKEN_LOWER);
  });

  it("throws on missing / invalid input", () => {
    assert.throws(() => parseSessionTokenHeader(undefined));
    assert.throws(() => parseSessionTokenHeader(""));
    assert.throws(() => parseSessionTokenHeader("zz"));
    assert.throws(() => parseSessionTokenHeader("0".repeat(63)));
  });
});

describe("getProviderCallbackRedirectUri", () => {
  it("uses the configured base URL", () => {
    assert.equal(
      getProviderCallbackRedirectUri("https://api.sesori.com", OAuthProviderName.Github),
      "https://api.sesori.com/auth/github/callback",
    );
    assert.equal(
      getProviderCallbackRedirectUri("https://api.sesori.com", OAuthProviderName.Google),
      "https://api.sesori.com/auth/google/callback",
    );
    assert.equal(
      getProviderCallbackRedirectUri("https://api.sesori.com", OAuthProviderName.Apple),
      "https://api.sesori.com/auth/apple/callback",
    );
  });

  it("preserves base-path prefixes when AUTH_BASE_URL is mounted under a subpath (codex-2a852c8)", () => {
    assert.equal(
      getProviderCallbackRedirectUri("https://example.com/authsvc", OAuthProviderName.Github),
      "https://example.com/authsvc/auth/github/callback",
    );
    assert.equal(
      getProviderCallbackRedirectUri("https://example.com/authsvc/", OAuthProviderName.Google),
      "https://example.com/authsvc/auth/google/callback",
    );
  });

  it("handles ports and non-standard hosts", () => {
    assert.equal(
      getProviderCallbackRedirectUri("http://localhost:3001", OAuthProviderName.Github),
      "http://localhost:3001/auth/github/callback",
    );
  });
});

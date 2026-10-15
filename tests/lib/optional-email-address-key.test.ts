import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveOptionalEmailAddressKey,
  normalizeOptionalEmailAddress,
} from "../../src/lib/optional-email-address-key.js";
import { OptionalEmailAddressKeyVersion } from "../../src/types/optional-email.js";

describe("optional email address keys", () => {
  it("normalizes only surrounding whitespace and case", () => {
    assert.equal(
      normalizeOptionalEmailAddress({ address: " Person.Name+Tag@Example.test " }),
      "person.name+tag@example.test",
    );
    assert.equal(normalizeOptionalEmailAddress({ address: "personname@example.test" }), "personname@example.test");
    assert.equal(normalizeOptionalEmailAddress({ address: "person.name@example.test" }), "person.name@example.test");
  });

  it("derives a versioned purpose-specific HMAC from the normalized address", () => {
    assert.deepEqual(
      deriveOptionalEmailAddressKey({
        address: " Person+Tag@Example.test ",
        secret: "0123456789abcdef0123456789abcdef",
        version: OptionalEmailAddressKeyVersion.V1,
      }),
      {
        addressKeyVersion: OptionalEmailAddressKeyVersion.V1,
        addressKey: "cdb54fc8180114de8d09840cfd56b299fed2e7c7e031d3edbce83974fef7787e",
      },
    );
  });

  it("rejects an invalid address instead of keying malformed input", () => {
    assert.throws(
      () =>
        deriveOptionalEmailAddressKey({
          address: "not-an-address",
          secret: "s".repeat(32),
          version: OptionalEmailAddressKeyVersion.V1,
        }),
      /internal_server_error/,
    );
  });

  it("rejects an address-key secret shorter than 32 bytes", () => {
    assert.throws(
      () =>
        deriveOptionalEmailAddressKey({
          address: "person@example.test",
          secret: "s".repeat(31),
          version: OptionalEmailAddressKeyVersion.V1,
        }),
      /internal_server_error/,
    );
  });

  it("rejects an undeclared key version", () => {
    assert.throws(
      () =>
        deriveOptionalEmailAddressKey({
          address: "person@example.test",
          secret: "s".repeat(32),
          version: "v2" as OptionalEmailAddressKeyVersion,
        }),
      /internal_server_error/,
    );
  });
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  isValidResendWebhookSigningSecret,
  ResendWebhookVerifier,
} from "../../src/services/resend-webhook-verifier.js";

const DOCUMENTED_SECRET = "whsec_plJ3nmyCDGBKInavdOK15jsl";
const DOCUMENTED_PAYLOAD = '{"event_type":"ping","data":{"success":true}}';
const DOCUMENTED_MESSAGE_ID = "msg_loFOjxBNrRLzqYUf";
const DOCUMENTED_TIMESTAMP = "1731705121";
const DOCUMENTED_SIGNATURE = "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=";

function signatureFor(rawBody: string): string {
  const secret = Buffer.from(DOCUMENTED_SECRET.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", secret)
    .update(`${DOCUMENTED_MESSAGE_ID}.${DOCUMENTED_TIMESTAMP}.${rawBody}`, "utf8")
    .digest("base64")}`;
}

describe("ResendWebhookVerifier", () => {
  it("rejects partial base64 padding while accepting canonical padded or unpadded secrets", () => {
    const padded = Buffer.alloc(16, 9).toString("base64");
    assert.equal(isValidResendWebhookSigningSecret(`whsec_${padded}`), true);
    assert.equal(isValidResendWebhookSigningSecret(`whsec_${padded.replace(/=+$/u, "")}`), true);
    assert.equal(isValidResendWebhookSigningSecret(`whsec_${padded.slice(0, -1)}`), false);
  });

  it("accepts the published vector at the time boundary and rejects a modified raw body", () => {
    const verifier = new ResendWebhookVerifier({
      signingSecret: DOCUMENTED_SECRET,
      clock: () => new Date((Number(DOCUMENTED_TIMESTAMP) + 300) * 1_000),
    });

    assert.deepEqual(
      verifier.verify({
        rawBody: DOCUMENTED_PAYLOAD,
        messageId: DOCUMENTED_MESSAGE_ID,
        timestamp: DOCUMENTED_TIMESTAMP,
        signature: `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${DOCUMENTED_SIGNATURE}`,
      }),
      { event_type: "ping", data: { success: true } },
    );
    assert.throws(
      () =>
        verifier.verify({
          rawBody: `${DOCUMENTED_PAYLOAD} `,
          messageId: DOCUMENTED_MESSAGE_ID,
          timestamp: DOCUMENTED_TIMESTAMP,
          signature: DOCUMENTED_SIGNATURE,
        }),
      /InvalidResendWebhookSignature/,
    );
  });

  it("rejects otherwise-valid signatures outside the five-minute timestamp window", () => {
    const oldVerifier = new ResendWebhookVerifier({
      signingSecret: DOCUMENTED_SECRET,
      clock: () => new Date((Number(DOCUMENTED_TIMESTAMP) + 301) * 1_000),
    });
    const futureVerifier = new ResendWebhookVerifier({
      signingSecret: DOCUMENTED_SECRET,
      clock: () => new Date((Number(DOCUMENTED_TIMESTAMP) - 301) * 1_000),
    });
    const input = {
      rawBody: DOCUMENTED_PAYLOAD,
      messageId: DOCUMENTED_MESSAGE_ID,
      timestamp: DOCUMENTED_TIMESTAMP,
      signature: DOCUMENTED_SIGNATURE,
    };

    assert.throws(() => oldVerifier.verify(input), /InvalidResendWebhookTimestamp/);
    assert.throws(() => futureVerifier.verify(input), /InvalidResendWebhookTimestamp/);
  });

  it("fails closed on malformed secrets, event ids, timestamps, signatures, and JSON", () => {
    for (const signingSecret of ["not-a-secret", "whsec_%%%", "whsec_YQ=="]) {
      assert.throws(() => new ResendWebhookVerifier({ signingSecret }), /InvalidResendWebhookSigningSecret/);
    }

    const verifier = new ResendWebhookVerifier({
      signingSecret: DOCUMENTED_SECRET,
      clock: () => new Date(Number(DOCUMENTED_TIMESTAMP) * 1_000),
    });
    const validInput = {
      rawBody: DOCUMENTED_PAYLOAD,
      messageId: DOCUMENTED_MESSAGE_ID,
      timestamp: DOCUMENTED_TIMESTAMP,
      signature: DOCUMENTED_SIGNATURE,
    };

    assert.throws(
      () => verifier.verify({ ...validInput, messageId: "m".repeat(257) }),
      /InvalidResendWebhookMessageId/,
    );
    assert.throws(() => verifier.verify({ ...validInput, timestamp: "1.5" }), /InvalidResendWebhookTimestamp/);
    assert.throws(() => verifier.verify({ ...validInput, signature: "v1,%%%" }), /InvalidResendWebhookSignature/);
    assert.throws(
      () => verifier.verify({ ...validInput, rawBody: "{", signature: signatureFor("{") }),
      /InvalidResendWebhookPayload/,
    );
  });
});

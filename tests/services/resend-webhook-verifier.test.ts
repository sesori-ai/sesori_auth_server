import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ResendWebhookVerifier } from "../../src/services/resend-webhook-verifier.js";

const DOCUMENTED_SECRET = "whsec_plJ3nmyCDGBKInavdOK15jsl";
const DOCUMENTED_PAYLOAD = '{"event_type":"ping","data":{"success":true}}';
const DOCUMENTED_MESSAGE_ID = "msg_loFOjxBNrRLzqYUf";
const DOCUMENTED_TIMESTAMP = "1731705121";
const DOCUMENTED_SIGNATURE = "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=";

describe("ResendWebhookVerifier", () => {
  it("accepts the published Svix signature vector and rejects a modified raw body", () => {
    const verifier = new ResendWebhookVerifier({
      signingSecret: DOCUMENTED_SECRET,
      clock: () => new Date(Number(DOCUMENTED_TIMESTAMP) * 1_000),
    });

    assert.deepEqual(
      verifier.verify({
        rawBody: DOCUMENTED_PAYLOAD,
        messageId: DOCUMENTED_MESSAGE_ID,
        timestamp: DOCUMENTED_TIMESTAMP,
        signature: DOCUMENTED_SIGNATURE,
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
});

import { createHmac, timingSafeEqual } from "node:crypto";

export class ResendWebhookVerifier {
  readonly #secret: Buffer;
  readonly #clock: () => Date;

  constructor(input: { signingSecret: string; clock?: () => Date }) {
    const match = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(input.signingSecret);
    if (!match) {
      throw new Error("InvalidResendWebhookSigningSecret");
    }
    this.#secret = Buffer.from(match[1] ?? "", "base64");
    if (this.#secret.byteLength < 16) {
      throw new Error("InvalidResendWebhookSigningSecret");
    }
    this.#clock = input.clock ?? (() => new Date());
  }

  verify(input: { rawBody: string; messageId: string; timestamp: string; signature: string }): unknown {
    if (!/^\d{1,12}$/.test(input.timestamp)) {
      throw new Error("InvalidResendWebhookTimestamp");
    }
    const timestampSeconds = Number(input.timestamp);
    const nowSeconds = Math.floor(this.#clock().getTime() / 1_000);
    if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > 300) {
      throw new Error("InvalidResendWebhookTimestamp");
    }

    const signedContent = `${input.messageId}.${input.timestamp}.${input.rawBody}`;
    const expected = createHmac("sha256", this.#secret).update(signedContent, "utf8").digest();
    const valid = input.signature.split(" ").some((candidate) => {
      const [version, encoded, ...rest] = candidate.split(",");
      if (version !== "v1" || !encoded || rest.length > 0) {
        return false;
      }
      const actual = Buffer.from(encoded, "base64");
      return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
    });
    if (!valid) {
      throw new Error("InvalidResendWebhookSignature");
    }

    try {
      return JSON.parse(input.rawBody) as unknown;
    } catch {
      throw new Error("InvalidResendWebhookPayload");
    }
  }
}

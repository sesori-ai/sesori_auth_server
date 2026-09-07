import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNING_SECRET_PATTERN = /^whsec_([A-Za-z0-9+/]+={0,2})$/;
const SIGNATURE_PATTERN = /^v1,([A-Za-z0-9+/]+={0,2})$/;
const MAX_WEBHOOK_EVENT_ID_LENGTH = 256;
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function decodeCanonicalBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
    return null;
  }

  const decoded = Buffer.from(value, "base64");
  const canonical = decoded.toString("base64");
  const unpaddedCanonical = canonical.replace(/=+$/u, "");
  return value === canonical || value === unpaddedCanonical ? decoded : null;
}

function decodeSigningSecret(signingSecret: string): Buffer | null {
  const match = SIGNING_SECRET_PATTERN.exec(signingSecret);
  if (!match) {
    return null;
  }

  const decoded = decodeCanonicalBase64(match[1] ?? "");
  return decoded && decoded.byteLength >= 16 ? decoded : null;
}

export function isValidResendWebhookSigningSecret(signingSecret: string): boolean {
  return decodeSigningSecret(signingSecret) !== null;
}

export class ResendWebhookVerifier {
  readonly #secret: Buffer;
  readonly #clock: () => Date;

  constructor(input: { signingSecret: string; clock?: () => Date }) {
    const secret = decodeSigningSecret(input.signingSecret);
    if (!secret) {
      throw new Error("InvalidResendWebhookSigningSecret");
    }

    this.#secret = Buffer.from(secret);
    this.#clock = input.clock ?? (() => new Date());
  }

  verify(input: { rawBody: string; messageId: string; timestamp: string; signature: string }): unknown {
    if (!input.messageId || input.messageId.length > MAX_WEBHOOK_EVENT_ID_LENGTH) {
      throw new Error("InvalidResendWebhookMessageId");
    }
    if (!/^\d{1,12}$/.test(input.timestamp)) {
      throw new Error("InvalidResendWebhookTimestamp");
    }

    const timestampSeconds = Number(input.timestamp);
    const nowSeconds = Math.floor(this.#clock().getTime() / 1_000);
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      !Number.isSafeInteger(nowSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > WEBHOOK_TOLERANCE_SECONDS
    ) {
      throw new Error("InvalidResendWebhookTimestamp");
    }

    const signedContent = `${input.messageId}.${input.timestamp}.${input.rawBody}`;
    const expected = createHmac("sha256", this.#secret).update(signedContent, "utf8").digest();
    const valid = input.signature
      .trim()
      .split(/\s+/u)
      .some((candidate) => {
        const match = SIGNATURE_PATTERN.exec(candidate);
        const actual = match ? decodeCanonicalBase64(match[1] ?? "") : null;
        return actual !== null && actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
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

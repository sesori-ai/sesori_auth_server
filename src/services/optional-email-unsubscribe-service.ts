import { createHmac, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { OptionalEmailPreferenceRepository } from "../repositories/optional-email-preference-repo.js";

const TOKEN_VERSION = "v1";
const tokenPayloadSchema = z
  .object({
    purpose: z.literal("optional_email_unsubscribe"),
    userId: z.string().regex(/^[a-f0-9]{24}$/),
  })
  .strict();

export class OptionalEmailUnsubscribeTokenService {
  readonly #signingSecret: Buffer;

  constructor(input: { signingSecret: Buffer }) {
    if (input.signingSecret.byteLength < 32) {
      throw new Error("OptionalEmailUnsubscribeSigningSecretTooShort");
    }
    this.#signingSecret = Buffer.from(input.signingSecret);
  }

  create(input: { userId: string }): string {
    if (!ObjectId.isValid(input.userId)) {
      throw new Error("InvalidOptionalEmailUnsubscribeUserId");
    }
    const payload = Buffer.from(
      JSON.stringify({ purpose: "optional_email_unsubscribe", userId: input.userId.toLowerCase() }),
      "utf8",
    ).toString("base64url");
    const unsigned = `${TOKEN_VERSION}.${payload}`;
    return `${unsigned}.${this.#signatureFor(unsigned)}`;
  }

  verify(input: { token: string }): string | null {
    const parts = input.token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
      return null;
    }

    const unsigned = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(this.#signatureFor(unsigned), "base64url");
    let actual: Buffer;
    try {
      actual = Buffer.from(parts[2] ?? "", "base64url");
    } catch {
      return null;
    }
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      return null;
    }

    try {
      const decoded = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as unknown;
      const result = tokenPayloadSchema.safeParse(decoded);
      return result.success ? result.data.userId : null;
    } catch {
      return null;
    }
  }

  #signatureFor(unsigned: string): string {
    return createHmac("sha256", this.#signingSecret).update(unsigned, "utf8").digest("base64url");
  }
}

export class OptionalEmailUnsubscribeService {
  readonly #preferenceRepo: OptionalEmailPreferenceRepository;
  readonly #tokenService: OptionalEmailUnsubscribeTokenService;
  readonly #clock: () => Date;

  constructor(input: {
    preferenceRepo: OptionalEmailPreferenceRepository;
    tokenService: OptionalEmailUnsubscribeTokenService;
    clock?: () => Date;
  }) {
    this.#preferenceRepo = input.preferenceRepo;
    this.#tokenService = input.tokenService;
    this.#clock = input.clock ?? (() => new Date());
  }

  isValid(input: { token: string }): boolean {
    return this.#tokenService.verify(input) !== null;
  }

  async unsubscribe(input: { token: string }): Promise<boolean> {
    const userId = this.#tokenService.verify(input);
    if (!userId) {
      return false;
    }
    await this.#preferenceRepo.unsubscribe({ userId, at: this.#clock() });
    return true;
  }
}

export function buildOptionalEmailUnsubscribeHeaders(input: {
  publicBaseUrl: string;
  token: string;
}): Record<"List-Unsubscribe" | "List-Unsubscribe-Post", string> {
  const url = new URL("/email/optional/unsubscribe", input.publicBaseUrl);
  url.searchParams.set("token", input.token);
  return {
    "List-Unsubscribe": `<${url.toString()}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

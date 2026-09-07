export type OptionalEmailProviderSendInput = {
  idempotencyKey: string;
  from: string;
  replyTo: string;
  recipient: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  tags: { name: string; value: string }[];
};

export interface OptionalEmailProvider {
  send(input: OptionalEmailProviderSendInput): Promise<{ providerEmailId: string }>;
}

export type ResendOptionalEmailErrorCode = "configuration" | "rate_limited" | "rejected" | "unavailable";

export class ResendOptionalEmailError extends Error {
  constructor(readonly code: ResendOptionalEmailErrorCode) {
    super("resend_email_failed");
    this.name = "ResendOptionalEmailError";
  }
}

export class ResendOptionalEmailAdapter implements OptionalEmailProvider {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(input: { apiKey: string; fetchFn?: typeof fetch; timeoutMs?: number }) {
    if (!input.apiKey) {
      throw new Error("MissingResendApiKey");
    }
    const timeoutMs = input.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("InvalidResendRequestTimeout");
    }
    this.#apiKey = input.apiKey;
    this.#fetch = input.fetchFn ?? fetch;
    this.#timeoutMs = timeoutMs;
  }

  async send(input: OptionalEmailProviderSendInput): Promise<{ providerEmailId: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({
          from: input.from,
          to: [input.recipient],
          subject: input.subject,
          html: input.html,
          text: input.text,
          reply_to: input.replyTo,
          headers: input.headers,
          tags: input.tags,
        }),
      });
    } catch {
      throw new ResendOptionalEmailError("unavailable");
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new ResendOptionalEmailError(classifyHttpFailure(response.status));
    }
    let body: { id?: unknown };
    try {
      body = (await response.json()) as { id?: unknown };
    } catch {
      throw new ResendOptionalEmailError("unavailable");
    }
    if (typeof body.id !== "string" || !body.id) {
      throw new ResendOptionalEmailError("unavailable");
    }
    return { providerEmailId: body.id };
  }
}

function classifyHttpFailure(status: number): ResendOptionalEmailErrorCode {
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 401 || status === 403) {
    return "configuration";
  }
  if (status >= 400 && status < 500) {
    return "rejected";
  }
  return "unavailable";
}

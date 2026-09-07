import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ResendOptionalEmailAdapter } from "../../src/clients/resend-optional-email-adapter.js";

describe("ResendOptionalEmailAdapter", () => {
  it("sends one unscheduled email with explicit identity, one-click headers, and provider idempotency", async () => {
    let captured: { input: Parameters<typeof fetch>[0]; init?: Parameters<typeof fetch>[1] } | null = null;
    const fetchFn: typeof fetch = async (input, init) => {
      captured = { input, init };
      return new Response(JSON.stringify({ id: "resend-email-id-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = new ResendOptionalEmailAdapter({
      apiKey: "re_test_placeholder_not_a_secret",
      fetchFn,
    });

    const result = await adapter.send({
      idempotencyKey: "optional/setup-2026-09/stable-key",
      from: "Sesori <hello@updates.sesori.com>",
      replyTo: "hello@sesori.com",
      recipient: "one@example.test",
      subject: "Finish setting up Sesori",
      html: "<p>Setup</p>",
      text: "Setup",
      headers: {
        "List-Unsubscribe": "<https://api.sesori.com/email/optional/unsubscribe?token=signed>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      tags: [
        { name: "category", value: "optional_setup_reminder" },
        { name: "campaign", value: "setup-2026-09" },
      ],
    });

    assert.deepEqual(result, { providerEmailId: "resend-email-id-1" });
    assert.equal(captured?.input, "https://api.resend.com/emails");
    assert.equal(captured?.init?.method, "POST");
    const requestHeaders = new Headers(captured?.init?.headers);
    assert.equal(requestHeaders.get("authorization"), "Bearer re_test_placeholder_not_a_secret");
    assert.equal(requestHeaders.get("content-type"), "application/json");
    assert.equal(requestHeaders.get("idempotency-key"), "optional/setup-2026-09/stable-key");
    assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
      from: "Sesori <hello@updates.sesori.com>",
      to: ["one@example.test"],
      subject: "Finish setting up Sesori",
      html: "<p>Setup</p>",
      text: "Setup",
      reply_to: "hello@sesori.com",
      headers: {
        "List-Unsubscribe": "<https://api.sesori.com/email/optional/unsubscribe?token=signed>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      tags: [
        { name: "category", value: "optional_setup_reminder" },
        { name: "campaign", value: "setup-2026-09" },
      ],
    });
  });

  it("classifies HTTP failures without exposing provider, key, or recipient details", async () => {
    for (const testCase of [
      { status: 429, code: "rate_limited" },
      { status: 401, code: "configuration" },
      { status: 422, code: "rejected" },
      { status: 503, code: "unavailable" },
    ]) {
      const adapter = new ResendOptionalEmailAdapter({
        apiKey: "re_test_sensitive_placeholder",
        fetchFn: async () =>
          new Response(JSON.stringify({ message: "provider detail for private@example.test" }), {
            status: testCase.status,
            headers: { "content-type": "application/json" },
          }),
      });
      let thrown: unknown;
      try {
        await adapter.send({
          idempotencyKey: `failure/${testCase.status}`,
          from: "Sesori <hello@updates.sesori.com>",
          replyTo: "hello@sesori.com",
          recipient: "private@example.test",
          subject: "Setup",
          html: "<p>Setup</p>",
          text: "Setup",
          headers: {},
          tags: [],
        });
      } catch (error) {
        thrown = error;
      }

      assert.equal((thrown as { code?: unknown }).code, testCase.code);
      assert.equal((thrown as Error).message, "resend_email_failed");
      assert.doesNotMatch(String(thrown), /private@example\.test|re_test_sensitive|provider detail/);
    }
  });

  it("sanitizes transport failures as unavailable", async () => {
    const adapter = new ResendOptionalEmailAdapter({
      apiKey: "re_test_sensitive_placeholder",
      fetchFn: async () => {
        throw new Error("socket detail for private@example.test");
      },
    });

    let thrown: unknown;
    try {
      await adapter.send({
        idempotencyKey: "failure/network",
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        recipient: "private@example.test",
        subject: "Setup",
        html: "<p>Setup</p>",
        text: "Setup",
        headers: {},
        tags: [],
      });
    } catch (error) {
      thrown = error;
    }

    assert.equal((thrown as { code?: unknown }).code, "unavailable");
    assert.equal((thrown as Error).message, "resend_email_failed");
    assert.doesNotMatch(String(thrown), /private@example\.test|socket detail/);
  });

  it("rejects malformed success payloads as unavailable", async () => {
    const adapter = new ResendOptionalEmailAdapter({
      apiKey: "re_test_placeholder_not_a_secret",
      fetchFn: async () => new Response("not-json", { status: 200 }),
    });

    await assert.rejects(
      adapter.send({
        idempotencyKey: "failure/malformed",
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        recipient: "one@example.test",
        subject: "Setup",
        html: "<p>Setup</p>",
        text: "Setup",
        headers: {},
        tags: [],
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "unavailable" && (error as Error).message === "resend_email_failed",
    );
  });

  it("passes a bounded abort signal to the provider request", async () => {
    let signalSeen = false;
    const adapter = new ResendOptionalEmailAdapter({
      apiKey: "re_test_placeholder_not_a_secret",
      timeoutMs: 5,
      fetchFn: async (_input, init) => {
        const signal = init?.signal;
        signalSeen = signal instanceof AbortSignal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("missing abort signal");
        }
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });

    await assert.rejects(
      adapter.send({
        idempotencyKey: "failure/timeout",
        from: "Sesori <hello@updates.sesori.com>",
        replyTo: "hello@sesori.com",
        recipient: "one@example.test",
        subject: "Setup",
        html: "<p>Setup</p>",
        text: "Setup",
        headers: {},
        tags: [],
      }),
      (error: unknown) => (error as { code?: unknown }).code === "unavailable",
    );
    assert.equal(signalSeen, true);
  });
});

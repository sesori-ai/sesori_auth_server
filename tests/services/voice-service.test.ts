import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import type { AsyncTranscriptionClient } from "../../src/clients/async-transcription-client.js";
import {
  AsyncTranscriptionPublicErrorPolicy,
  TranscriptionFailure,
  TranscriptionFailureReason,
  type TranscriptionResult,
} from "../../src/types/transcription.js";

const BOUNDARY = "----TestBoundaryVoiceService";

/** Provider stub whose next outcome each test sets. */
class StubTranscriptionClient implements AsyncTranscriptionClient {
  next: (() => Promise<TranscriptionResult>) | null = null;
  lastTerms: string[] | null = null;

  async transcribe(request: { terms: string[] }): Promise<TranscriptionResult> {
    this.lastTerms = request.terms;
    if (!this.next) {
      return { text: "default text", durationSeconds: 1 };
    }
    return this.next();
  }
}

function multipart(): { body: Buffer; contentType: string } {
  const body = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="audio"; filename="a.m4a"\r\n` +
        `Content-Type: audio/m4a\r\n\r\n`,
    ),
    Buffer.from("fake-audio-data-for-testing"),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${BOUNDARY}` };
}

describe("VoiceService provider failure mapping", () => {
  let ctx: TestContext;
  let legacyCtx: TestContext;
  const provider = new StubTranscriptionClient();

  before(async () => {
    ctx = await createTestApp({
      asyncTranscriptionClient: provider,
      asyncTranscriptionPublicErrorPolicy: AsyncTranscriptionPublicErrorPolicy.DetailedV1,
    });
    legacyCtx = await createTestApp({
      asyncTranscriptionClient: provider,
      asyncTranscriptionPublicErrorPolicy: AsyncTranscriptionPublicErrorPolicy.LegacyOpenAiV1,
    });
  });

  after(async () => {
    await legacyCtx.cleanup();
    await ctx.cleanup();
  });

  beforeEach(() => {
    provider.next = null;
    provider.lastTerms = null;
  });

  async function post(args: { accessToken: string; context?: TestContext }) {
    const { body, contentType } = multipart();
    return (args.context ?? ctx).app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: { authorization: `Bearer ${args.accessToken}`, "content-type": contentType },
      payload: body,
    });
  }

  // The expected Retry-After is the exact header value, not just its presence:
  // a capacity rejection the provider did not quantify uses a deliberately
  // longer cadence than a generic transient failure.
  const cases: [TranscriptionFailureReason, number, string, boolean, string | undefined][] = [
    [TranscriptionFailureReason.InvalidInput, 400, "bad_request", false, undefined],
    [TranscriptionFailureReason.UnusableAudio, 502, "transcription_provider_error", false, undefined],
    [TranscriptionFailureReason.QuotaExhausted, 503, "transcription_unavailable", false, undefined],
    [TranscriptionFailureReason.Capacity, 503, "transcription_unavailable", true, "5"],
    [TranscriptionFailureReason.Unavailable, 503, "transcription_unavailable", true, "1"],
    [TranscriptionFailureReason.Timeout, 504, "transcription_timeout", true, "1"],
    [TranscriptionFailureReason.ProviderRejected, 500, "transcription_configuration_error", false, undefined],
    [TranscriptionFailureReason.MalformedOutput, 502, "transcription_provider_error", true, "1"],
    [TranscriptionFailureReason.Internal, 500, "internal_server_error", false, undefined],
  ];

  for (const [reason, status, errorCode, retryable, expectedRetryAfter] of cases) {
    it(`maps ${reason} to HTTP ${status} ${errorCode}`, async () => {
      const user = await ctx.createUser();
      provider.next = async () => {
        throw new TranscriptionFailure(reason);
      };

      const res = await post({ accessToken: user.accessToken });

      assert.equal(res.statusCode, status);
      assert.deepEqual(res.json(), { error: errorCode, retryable });
      assert.equal(res.headers["retry-after"], expectedRetryAfter, `Retry-After for ${reason}`);
    });
  }

  for (const [reason, , , retryable] of cases) {
    it(`preserves the legacy OpenAI HTTP contract for ${reason}`, async () => {
      const user = await legacyCtx.createUser();
      provider.next = async () => {
        throw new TranscriptionFailure(reason);
      };

      const res = await post({ accessToken: user.accessToken, context: legacyCtx });

      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.json(), { error: "internal_server_error", retryable });
      assert.equal(res.headers["retry-after"], undefined);
    });
  }

  for (const [name, context] of [
    ["detailed", () => ctx],
    ["legacy", () => legacyCtx],
  ] as const) {
    it(`maps an unexpected ${name} provider error to terminal internal failure`, async () => {
      const target = context();
      const user = await target.createUser();
      provider.next = async () => {
        throw new Error("unexpected provider failure");
      };

      const res = await post({ accessToken: user.accessToken, context: target });

      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.json(), { error: "internal_server_error", retryable: false });
      assert.equal(res.headers["retry-after"], undefined);
    });
  }

  it("answers a still-connected caller when cancellation surfaces from the provider", async () => {
    const user = await ctx.createUser();
    // An SDK-internal abort can raise `cancelled` while the client is still
    // connected. Hijacking then would leak the socket, so a response is owed.
    provider.next = async () => {
      throw new TranscriptionFailure(TranscriptionFailureReason.Cancelled);
    };

    const res = await post({ accessToken: user.accessToken });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json<{ error: string }>().error, "bad_request");

    // Cancellation is the caller's own doing, so it is explicitly terminal
    // and has no cooldown.
    assert.equal(res.json<{ retryable?: boolean }>().retryable, false);
    assert.equal(res.headers["retry-after"], undefined);
  });

  it("keeps connected cancellation terminal under the legacy policy", async () => {
    const user = await legacyCtx.createUser();
    provider.next = async () => {
      throw new TranscriptionFailure(TranscriptionFailureReason.Cancelled);
    };

    const res = await post({ accessToken: user.accessToken, context: legacyCtx });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "bad_request", retryable: false });
    assert.equal(res.headers["retry-after"], undefined);
  });

  it("writes a provider-stated cooldown into Retry-After", async () => {
    const user = await ctx.createUser();
    provider.next = async () => {
      throw new TranscriptionFailure(TranscriptionFailureReason.Capacity, { retryAfterSeconds: 42 });
    };

    const res = await post({ accessToken: user.accessToken });

    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["retry-after"], "42");
  });

  it("keeps provider diagnostics in server logs without exposing them in the client response", async () => {
    const user = await ctx.createUser();
    const providerMessageSentinel = "voice-provider-diagnostic-message-9f4c2d";
    const providerPropertySentinel = "voice-provider-request-id-72aa31";
    const providerAuthorizationSentinel = "voice-provider-authorization-secret-b80f21";
    const providerCookieSentinel = "voice-provider-cookie-secret-734dab";
    const nestedAuthorizationSentinel = "voice-provider-nested-authorization-secret-5df8ab";
    const deepCookieSentinel = "voice-provider-deep-cookie-secret-50673c";
    const providerCause = Object.assign(new Error(providerMessageSentinel), {
      name: "SensitiveProviderError",
      cause: Object.assign(new Error("nested provider failure"), {
        headers: { authorization: nestedAuthorizationSentinel },
        cause: Object.assign(new Error("intermediate wrapper without headers"), {
          cause: Object.assign(new Error("deep provider failure"), {
            headers: { cookie: deepCookieSentinel },
          }),
        }),
      }),
      providerRequestId: providerPropertySentinel,
      headers: {
        authorization: providerAuthorizationSentinel,
        cookie: providerCookieSentinel,
        "x-request-id": providerPropertySentinel,
      },
    });
    const loggedEntries: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: Parameters<typeof console.error>) => {
      loggedEntries.push(args.map((arg) => inspect(arg, { depth: null })).join(" "));
    };

    try {
      provider.next = async () => {
        throw new TranscriptionFailure(TranscriptionFailureReason.ProviderRejected, { cause: providerCause });
      };

      const res = await post({ accessToken: user.accessToken });

      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.json(), { error: "transcription_configuration_error", retryable: false });
      const logs = loggedEntries.join("\n");
      assert.match(logs, /SensitiveProviderError/);
      assert.match(logs, new RegExp(providerMessageSentinel));
      assert.match(logs, new RegExp(providerPropertySentinel));
      assert.doesNotMatch(logs, new RegExp(providerAuthorizationSentinel));
      assert.doesNotMatch(logs, new RegExp(providerCookieSentinel));
      assert.doesNotMatch(logs, new RegExp(nestedAuthorizationSentinel));
      assert.doesNotMatch(logs, new RegExp(deepCookieSentinel));
      assert.match(logs, /\[redacted\]/);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("caps an implausible provider cooldown instead of stalling the caller", async () => {
    const user = await ctx.createUser();
    provider.next = async () => {
      throw new TranscriptionFailure(TranscriptionFailureReason.Capacity, { retryAfterSeconds: 86_400 });
    };

    const res = await post({ accessToken: user.accessToken });

    assert.equal(res.headers["retry-after"], "300");
  });

  it("keeps the daily quota rejection distinct from provider capacity", async () => {
    const user = await ctx.createUser();
    provider.next = async () => ({ text: "ok", durationSeconds: 3_600 });

    assert.equal((await post({ accessToken: user.accessToken })).statusCode, 200);
    const exhausted = await post({ accessToken: user.accessToken });

    assert.equal(exhausted.statusCode, 429);
    assert.deepEqual(exhausted.json(), {
      error: "quota_exceeded",
      service: "transcription",
      retryable: false,
    });
    assert.equal(exhausted.headers["retry-after"], undefined);
  });

  it("passes the project's glossary terms to the provider", async () => {
    const user = await ctx.createUser();
    const projectKey = `prj_v1_${"A".repeat(43)}`;
    await ctx.app.inject({
      method: "POST",
      url: "/voice/glossary",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ projectKey, words: ["Sesori"] }),
    });

    const { body, contentType } = multipart();
    const withKey = Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="projectKey"\r\n\r\n${projectKey}\r\n`),
      body,
    ]);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/voice/transcribe",
      headers: { authorization: `Bearer ${user.accessToken}`, "content-type": contentType },
      payload: withKey,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(provider.lastTerms, ["Sesori"]);
  });

  it("sends no terms when the request omits a project key", async () => {
    const user = await ctx.createUser();

    assert.equal((await post({ accessToken: user.accessToken })).statusCode, 200);
    assert.deepEqual(provider.lastTerms, []);
  });
});

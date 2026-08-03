import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify, { type LightMyRequestResponse } from "fastify";
import { ApiError, ServiceUnavailableError } from "../../src/lib/errors.js";
import { registerErrorHandler } from "../../src/server.js";

describe("ApiError retry metadata", () => {
  it("accepts an absent or positive safe-integer retry delay", () => {
    assert.equal(new ApiError("ordinary_error", 500).retryAfterSeconds, undefined);
    assert.equal(new ApiError("retryable_error", 503, undefined, undefined, 1).retryAfterSeconds, 1);
    assert.equal(
      new ApiError("retryable_error", 503, undefined, undefined, Number.MAX_SAFE_INTEGER).retryAfterSeconds,
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("rejects every invalid retry delay with a fixed value-free error", () => {
    for (const retryAfterSeconds of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new ApiError("retryable_error", 503, undefined, undefined, retryAfterSeconds),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, "Error");
          assert.equal(error.message, "InvalidRetryAfterSeconds");
          return true;
        },
      );
    }
  });

  it("fixes service-unavailable responses to HTTP 503 with a one-second retry", () => {
    const nestedError = new Error("nested");
    const error = new ServiceUnavailableError({ debugMessage: "debug", nestedError });

    assert.equal(error.message, "service_unavailable");
    assert.equal(error.errorCode, 503);
    assert.equal(error.retryAfterSeconds, 1);
    assert.equal(error.debugMessage, "debug");
    assert.equal(error.nestedError, nestedError);
  });
});

describe("registerErrorHandler", () => {
  it("emits Retry-After from typed retry metadata and preserves the JSON response", async () => {
    const response = await injectThrownError(new ServiceUnavailableError());

    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["retry-after"], "1");
    assert.deepEqual(response.json(), { error: "service_unavailable" });
  });

  it("does not infer Retry-After from an ordinary ApiError message", async () => {
    const response = await injectThrownError(new ApiError("Retry-After: 60", 503));

    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["retry-after"], undefined);
    assert.deepEqual(response.json(), { error: "Retry-After: 60" });
  });

  it("does not emit Retry-After for framework 4xx errors", async () => {
    const frameworkError = Object.assign(new Error("framework_bad_request"), {
      statusCode: 422,
      retryAfterSeconds: 60,
    });
    const response = await injectThrownError(frameworkError);

    assert.equal(response.statusCode, 422);
    assert.equal(response.headers["retry-after"], undefined);
    assert.deepEqual(response.json(), { error: "framework_bad_request" });
  });

  it("does not emit Retry-After for unhandled errors", async (t) => {
    t.mock.method(console, "error", () => {});
    const unhandledError = Object.assign(new Error("Retry-After: 60"), { retryAfterSeconds: 60 });
    const response = await injectThrownError(unhandledError);

    assert.equal(response.statusCode, 500);
    assert.equal(response.headers["retry-after"], undefined);
    assert.deepEqual(response.json(), { error: "internal_server_error" });
  });
});

async function injectThrownError(error: unknown): Promise<LightMyRequestResponse> {
  const app = Fastify({ disableRequestLogging: true });
  registerErrorHandler(app);
  app.get("/error", async () => {
    throw error;
  });

  try {
    return await app.inject({ method: "GET", url: "/error" });
  } finally {
    await app.close();
  }
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify, { type LightMyRequestResponse } from "fastify";
import { ApiError, safeErrorType, ServiceUnavailableError } from "../../src/lib/errors.js";
import { registerErrorHandler } from "../../src/server.js";

describe("ApiError retry metadata", () => {
  it("accepts valid retry delays and rejects every invalid value", () => {
    for (const retryAfterSeconds of [undefined, 1, Number.MAX_SAFE_INTEGER]) {
      assert.equal(
        new ApiError("retryable_error", 503, undefined, undefined, retryAfterSeconds).retryAfterSeconds,
        retryAfterSeconds,
      );
    }

    for (const retryAfterSeconds of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => new ApiError("retryable_error", 503, undefined, undefined, retryAfterSeconds), {
        name: "Error",
        message: "InvalidRetryAfterSeconds",
      });
    }
  });

  it("fixes service-unavailable responses to HTTP 503 with a one-second retry", () => {
    const nestedError = new Error("nested");
    const error = new ServiceUnavailableError({ debugMessage: "debug", nestedError });

    assert.deepEqual(
      [error.message, error.errorCode, error.retryAfterSeconds, error.debugMessage],
      ["service_unavailable", 503, 1, "debug"],
    );
    assert.equal(error.nestedError, nestedError);
  });
});

describe("safeErrorType", () => {
  it("returns only bounded error type names and never throws", () => {
    const throwingName = new Error("private");
    Object.defineProperty(throwingName, "name", {
      get() {
        throw new Error("PRIVATE_NAME_GETTER");
      },
    });

    assert.equal(safeErrorType({ error: new TypeError("private") }), "TypeError");
    assert.equal(safeErrorType({ error: Object.assign(new Error("private"), { name: "line\nbreak" }) }), "Error");
    assert.equal(safeErrorType({ error: Object.assign(new Error("private"), { name: "A".repeat(129) }) }), "Error");
    assert.equal(safeErrorType({ error: throwingName }), "UnknownError");
    assert.equal(safeErrorType({ error: "private" }), "UnknownError");
  });
});

describe("registerErrorHandler", () => {
  it("emits Retry-After only from typed retry metadata", async (t) => {
    t.mock.method(console, "error", () => {});
    const cases: Array<[unknown, number, string | undefined, string]> = [
      [new ServiceUnavailableError(), 503, "1", "service_unavailable"],
      [new ApiError("Retry-After: 60", 503), 503, undefined, "Retry-After: 60"],
      [
        Object.assign(new Error("framework_bad_request"), { statusCode: 422, retryAfterSeconds: 60 }),
        422,
        undefined,
        "framework_bad_request",
      ],
      [Object.assign(new Error("Retry-After: 60"), { retryAfterSeconds: 60 }), 500, undefined, "internal_server_error"],
    ];
    for (const [error, status, retryAfter, responseError] of cases) {
      const response = await injectThrownError(error);
      assert.deepEqual(
        [response.statusCode, response.headers["retry-after"], response.json()],
        [status, retryAfter, { error: responseError }],
      );
    }
  });
});

async function injectThrownError(error: unknown): Promise<LightMyRequestResponse> {
  const app = Fastify({ disableRequestLogging: true });
  registerErrorHandler(app);
  app.get("/error", () => Promise.reject(error));

  try {
    return await app.inject({ method: "GET", url: "/error" });
  } finally {
    await app.close();
  }
}

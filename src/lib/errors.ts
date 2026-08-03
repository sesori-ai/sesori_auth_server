export class ApiError extends Error {
  public responseBody?: Record<string, unknown>;
  public readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    public readonly errorCode: number,
    public readonly debugMessage?: string,
    public readonly nestedError?: unknown,
    retryAfterSeconds?: number,
  ) {
    super(message);

    if (retryAfterSeconds !== undefined && (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds <= 0)) {
      throw new Error("InvalidRetryAfterSeconds");
    }

    this.retryAfterSeconds = retryAfterSeconds;
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = this.constructor.name;
  }
}

export class BadRequestError extends ApiError {
  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("bad_request", 400, opts?.debugMessage, opts?.nestedError);
  }
}

export class UnauthenticatedError extends ApiError {
  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("unauthenticated", 401, opts?.debugMessage, opts?.nestedError);
  }
}

export class NotFoundError extends ApiError {
  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("not_found", 404, opts?.debugMessage, opts?.nestedError);
  }
}

export class InternalServerError extends ApiError {
  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("internal_server_error", 500, opts?.debugMessage, opts?.nestedError);
  }
}

export class QuotaExceededError extends ApiError {
  constructor(opts: { service: string; debugMessage?: string; nestedError?: unknown }) {
    super("quota_exceeded", 429, opts.debugMessage, opts.nestedError);
    this.responseBody = { service: opts.service };
  }
}

export class BadGatewayError extends ApiError {
  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("bad_gateway", 502, opts?.debugMessage, opts?.nestedError);
  }
}

export class ServiceUnavailableError extends ApiError {
  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("service_unavailable", 503, opts?.debugMessage, opts?.nestedError, 1);
  }
}

export function safeErrorType(input: { error: unknown }): string {
  try {
    if (!(input.error instanceof Error)) {
      return "UnknownError";
    }

    const name = input.error.name;
    return /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name) ? name : "Error";
  } catch {
    return "UnknownError";
  }
}

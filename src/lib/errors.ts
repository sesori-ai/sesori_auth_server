export class ApiError extends Error {
  public responseBody?: Record<string, unknown>;
  /** Positive whole seconds for a `Retry-After` header, set only by retryable errors. */
  public readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    public readonly errorCode: number,
    public readonly debugMessage?: string,
    public readonly nestedError?: unknown,
  ) {
    super(message);
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

/**
 * Transcription provider failures. Each carries a fixed `retryable` flag so a
 * client can distinguish a transient outage from a permanent rejection; the
 * additive field is safe for released apps to ignore.
 */
export class TranscriptionUnavailableError extends ApiError {
  public readonly retryAfterSeconds = 1;

  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("transcription_unavailable", 503, opts?.debugMessage, opts?.nestedError);
    this.responseBody = { retryable: true };
  }
}

export class TranscriptionTimeoutError extends ApiError {
  public readonly retryAfterSeconds = 1;

  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("transcription_timeout", 504, opts?.debugMessage, opts?.nestedError);
    this.responseBody = { retryable: true };
  }
}

export class TranscriptionProviderError extends ApiError {
  public readonly retryAfterSeconds = 1;

  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("transcription_provider_error", 502, opts?.debugMessage, opts?.nestedError);
    this.responseBody = { retryable: true };
  }
}

export class TranscriptionConfigurationError extends ApiError {
  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("transcription_configuration_error", 500, opts?.debugMessage, opts?.nestedError);
    this.responseBody = { retryable: false };
  }
}

export function safeErrorType(input: { error: unknown }): string {
  return input.error instanceof Error ? input.error.name : "UnknownError";
}

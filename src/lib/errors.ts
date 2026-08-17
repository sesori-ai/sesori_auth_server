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

const DEFAULT_RETRY_AFTER_SECONDS = 1;

/**
 * Upper bound on any provider-advised cooldown. A provider asking for a wait
 * longer than this is more likely misconfigured than authoritative, and the
 * value becomes a client-visible stall, so it is capped rather than trusted.
 */
const MAX_RETRY_AFTER_SECONDS = 300;

/**
 * Normalizes an untrusted provider-advised cooldown into a header-safe value.
 * Absent or nonsensical input falls back to the shipped 1-second default.
 */
function clampRetryAfterSeconds(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isSafeInteger(seconds) || seconds < DEFAULT_RETRY_AFTER_SECONDS) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }

  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

type RetryableErrorOptions = {
  debugMessage?: string;
  nestedError?: unknown;
  /** Provider-advised cooldown in whole seconds; clamped before use. */
  retryAfterSeconds?: number;
};

/**
 * The process is shutting down and cannot answer this request truthfully.
 * Used where refusing beats guessing — a long poll released for shutdown has
 * no verified answer to serve, and a wrong one would be indistinguishable from
 * a real result. Mirrors the `service_restarting` signal the OAuth status poll
 * returns for `PendingAuthStatus.Shutdown`.
 */
export class ServiceRestartingError extends ApiError {
  public readonly retryAfterSeconds: number;

  constructor(opts?: RetryableErrorOptions) {
    super("service_restarting", 503, opts?.debugMessage, opts?.nestedError);
    this.responseBody = { retryable: true };
    this.retryAfterSeconds = clampRetryAfterSeconds(opts?.retryAfterSeconds);
  }
}

/**
 * Transcription provider failures. Each carries a fixed `retryable` flag so a
 * client can distinguish a transient outage from a permanent rejection; the
 * additive field is safe for released apps to ignore.
 */
export class TranscriptionUnavailableError extends ApiError {
  public readonly retryAfterSeconds: number;

  constructor(opts?: RetryableErrorOptions) {
    super("transcription_unavailable", 503, opts?.debugMessage, opts?.nestedError);
    this.responseBody = { retryable: true };
    this.retryAfterSeconds = clampRetryAfterSeconds(opts?.retryAfterSeconds);
  }
}

export class TranscriptionTimeoutError extends ApiError {
  public readonly retryAfterSeconds: number;

  constructor(opts?: RetryableErrorOptions) {
    super("transcription_timeout", 504, opts?.debugMessage, opts?.nestedError);
    this.responseBody = { retryable: true };
    this.retryAfterSeconds = clampRetryAfterSeconds(opts?.retryAfterSeconds);
  }
}

export class TranscriptionProviderError extends ApiError {
  public readonly retryAfterSeconds: number;

  constructor(opts?: RetryableErrorOptions) {
    super("transcription_provider_error", 502, opts?.debugMessage, opts?.nestedError);
    this.responseBody = { retryable: true };
    this.retryAfterSeconds = clampRetryAfterSeconds(opts?.retryAfterSeconds);
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

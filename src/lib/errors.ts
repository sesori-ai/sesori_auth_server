export class ApiError extends Error {
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
  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("quota_exceeded", 429, opts?.debugMessage, opts?.nestedError);
  }
}

export class BadGatewayError extends ApiError {
  constructor(opts?: { debugMessage?: string; nestedError?: unknown }) {
    super("bad_gateway", 502, opts?.debugMessage, opts?.nestedError);
  }
}

export class WithMemoryError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(
    message: string,
    options: { status: number; code: string; details?: unknown; requestId?: string }
  ) {
    super(message);
    this.name = "WithMemoryError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
  }

  static UnauthorizedError: typeof UnauthorizedError;
  static InvalidRequestError: typeof InvalidRequestError;
  static NotFoundError: typeof NotFoundError;
  static QuotaExceededError: typeof QuotaExceededError;
  static PlanRequiredError: typeof PlanRequiredError;
  static ExtractionFailedError: typeof ExtractionFailedError;
  static KeyExpiredError: typeof KeyExpiredError;
  static ContainerLimitExceededError: typeof ContainerLimitExceededError;
  static ConfirmationRequiredError: typeof ConfirmationRequiredError;
  static TimeoutError: typeof TimeoutError;
  static NetworkError: typeof NetworkError;
}

type ErrorOptions = Omit<ConstructorParameters<typeof WithMemoryError>[1], "code">;

export class UnauthorizedError extends WithMemoryError {
  constructor(message: string, options: ErrorOptions) {
    super(message, { ...options, code: "unauthorized" });
    this.name = "UnauthorizedError";
  }
}

export class KeyExpiredError extends WithMemoryError {
  constructor(message: string, options: ErrorOptions) {
    super(message, { ...options, code: "key_expired" });
    this.name = "KeyExpiredError";
  }
}

export class InvalidRequestError extends WithMemoryError {
  constructor(message: string, options: ErrorOptions) {
    super(message, { ...options, code: "invalid_request" });
    this.name = "InvalidRequestError";
  }
}

export class NotFoundError extends WithMemoryError {
  constructor(message: string, options: ErrorOptions) {
    super(message, { ...options, code: "not_found" });
    this.name = "NotFoundError";
  }
}

export class QuotaExceededError extends WithMemoryError {
  constructor(message: string, options: ErrorOptions) {
    super(message, { ...options, code: "quota_exceeded" });
    this.name = "QuotaExceededError";
  }
}

export class PlanRequiredError extends WithMemoryError {
  constructor(message: string, options: ErrorOptions) {
    super(message, { ...options, code: "plan_required" });
    this.name = "PlanRequiredError";
  }
}

export class ExtractionFailedError extends WithMemoryError {
  constructor(message: string, options: ErrorOptions) {
    super(message, { ...options, code: "extraction_failed" });
    this.name = "ExtractionFailedError";
  }
}

export class ContainerLimitExceededError extends WithMemoryError {
  constructor(message: string, options: ErrorOptions) {
    super(message, { ...options, code: "container_limit_exceeded" });
    this.name = "ContainerLimitExceededError";
  }
}

export class ConfirmationRequiredError extends WithMemoryError {
  constructor(message: string, options: ErrorOptions) {
    super(message, { ...options, code: "confirmation_required" });
    this.name = "ConfirmationRequiredError";
  }
}

export class TimeoutError extends WithMemoryError {
  constructor(message: string, options?: Omit<ErrorOptions, "status">) {
    super(message, { ...options, status: 0, code: "timeout" });
    this.name = "TimeoutError";
  }
}

export class NetworkError extends WithMemoryError {
  constructor(message: string, options?: Omit<ErrorOptions, "status">) {
    super(message, { ...options, status: 0, code: "network_error" });
    this.name = "NetworkError";
  }
}

// Wire static properties
WithMemoryError.UnauthorizedError = UnauthorizedError;
WithMemoryError.InvalidRequestError = InvalidRequestError;
WithMemoryError.NotFoundError = NotFoundError;
WithMemoryError.QuotaExceededError = QuotaExceededError;
WithMemoryError.PlanRequiredError = PlanRequiredError;
WithMemoryError.ExtractionFailedError = ExtractionFailedError;
WithMemoryError.KeyExpiredError = KeyExpiredError;
WithMemoryError.ContainerLimitExceededError = ContainerLimitExceededError;
WithMemoryError.ConfirmationRequiredError = ConfirmationRequiredError;
WithMemoryError.TimeoutError = TimeoutError;
WithMemoryError.NetworkError = NetworkError;

/**
 * Factory that maps an error code to the appropriate subclass.
 * Falls back to the base WithMemoryError for unrecognized codes.
 */
export function createError(
  message: string,
  options: { status: number; code: string; details?: unknown; requestId?: string }
): WithMemoryError {
  const opts = { status: options.status, details: options.details, requestId: options.requestId };
  switch (options.code) {
    case "unauthorized":
      return new UnauthorizedError(message, opts);
    case "key_expired":
      return new KeyExpiredError(message, opts);
    case "invalid_request":
      return new InvalidRequestError(message, opts);
    case "not_found":
      return new NotFoundError(message, opts);
    case "quota_exceeded":
      return new QuotaExceededError(message, opts);
    case "plan_required":
      return new PlanRequiredError(message, opts);
    case "container_limit_exceeded":
      return new ContainerLimitExceededError(message, opts);
    case "confirmation_required":
      return new ConfirmationRequiredError(message, opts);
    case "extraction_failed":
      return new ExtractionFailedError(message, opts);
    default:
      return new WithMemoryError(message, options);
  }
}

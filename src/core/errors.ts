/**
 * Error hierarchy plus the single parser for the three error-body shapes the API emits:
 *
 * - **A** — 401 from the gateway middleware: `{ error, message, code }`
 * - **B** — FastAPI `HTTPException`: `{ detail: "message" }`
 * - **C** — 422 validation: `{ detail: [{ loc, msg, type }] }`
 */

import type { RateLimitInfo } from "./ratelimit.js";
import type { Headers } from "./types.js";

/** One entry of a FastAPI 422 validation payload. */
export interface ValidationErrorItem {
  loc: (string | number)[];
  msg: string;
  type: string;
}

/** Normalized view of an error response body, whichever shape it arrived in. */
export interface ParsedErrorBody {
  message: string;
  /** Machine-readable code from gateway 401 bodies (e.g. `MARKETPLACE_ACCESS_REQUIRED`). */
  code: string | null;
  /** Populated only for 422 validation payloads. */
  errors: ValidationErrorItem[] | null;
}

/** Base class of every error thrown by this SDK. */
export class SkyLinkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The request never produced an HTTP response (DNS failure, socket reset, abort, …). */
export class APIConnectionError extends SkyLinkError {
  constructor(message = "Connection error.", options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The request exceeded the configured deadline. */
export class APITimeoutError extends APIConnectionError {
  constructor(message = "Request timed out.", options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Initializer for {@link APIStatusError} and its subclasses. */
export interface APIStatusErrorInit {
  status?: number;
  headers?: Headers;
  body?: unknown;
  code?: string | null;
}

/** The API returned a non-2xx status code. */
export class APIStatusError extends SkyLinkError {
  /** HTTP status code of the response. */
  readonly status: number;
  /** Alias of {@link status}. */
  readonly statusCode: number;
  /** Response headers, lower-cased keys. */
  readonly headers: Headers;
  /** Parsed JSON body when the response was JSON, otherwise the raw text (or `null`). */
  readonly body: unknown;
  /** Machine-readable code when the body carried one. */
  readonly code: string | null;

  constructor(message: string, init: APIStatusErrorInit = {}) {
    super(message);
    this.status = init.status ?? 0;
    this.statusCode = this.status;
    this.headers = init.headers ?? {};
    this.body = init.body ?? null;
    this.code = init.code ?? null;
  }
}

/** 400 — malformed request (v2/v3 endpoints use this for bad input). */
export class BadRequestError extends APIStatusError {
  constructor(message: string, init: APIStatusErrorInit = {}) {
    super(message, { ...init, status: init.status ?? 400 });
  }
}

/** 401 — missing or rejected API key. Also thrown at construction time when no key is configured. */
export class AuthenticationError extends APIStatusError {
  constructor(message: string, init: APIStatusErrorInit = {}) {
    super(message, { ...init, status: init.status ?? 401 });
  }
}

/** 403 — the key is valid but the plan does not permit this call. */
export class PermissionDeniedError extends APIStatusError {
  constructor(message: string, init: APIStatusErrorInit = {}) {
    super(message, { ...init, status: init.status ?? 403 });
  }
}

/** 404 — resource does not exist. Note that some lookups signal "not found" with HTTP 200 instead. */
export class NotFoundError extends APIStatusError {
  constructor(message: string, init: APIStatusErrorInit = {}) {
    super(message, { ...init, status: init.status ?? 404 });
  }
}

/** 422 — request validation failed; {@link errors} holds the per-field details when present. */
export class UnprocessableEntityError extends APIStatusError {
  /** Field-level validation failures, when the body used the list form. */
  readonly errors: ValidationErrorItem[];

  constructor(
    message: string,
    init: APIStatusErrorInit & { errors?: ValidationErrorItem[] | null } = {},
  ) {
    super(message, { ...init, status: init.status ?? 422 });
    this.errors = init.errors ?? [];
  }
}

/** 429 — quota exhausted. Carries the parsed quota headers and the `Retry-After` hint. */
export class RateLimitError extends APIStatusError {
  /** Quota snapshot parsed from the channel's `X-RateLimit-*` headers, when present. */
  readonly rateLimit: RateLimitInfo | null;
  /** Milliseconds to wait before retrying, derived from `Retry-After` (capped at 60s). */
  readonly retryAfter: number | null;

  constructor(
    message: string,
    init: APIStatusErrorInit & {
      rateLimit?: RateLimitInfo | null;
      retryAfter?: number | null;
    } = {},
  ) {
    super(message, { ...init, status: init.status ?? 429 });
    this.rateLimit = init.rateLimit ?? null;
    this.retryAfter = init.retryAfter ?? null;
  }
}

/** 5xx — the API failed to handle the request. */
export class InternalServerError extends APIStatusError {
  constructor(message: string, init: APIStatusErrorInit = {}) {
    super(message, { ...init, status: init.status ?? 500 });
  }
}

/** 503 — an upstream data source is unavailable. Retryable. */
export class ServiceUnavailableError extends InternalServerError {
  constructor(message: string, init: APIStatusErrorInit = {}) {
    super(message, { ...init, status: init.status ?? 503 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidationItem(value: unknown): value is ValidationErrorItem {
  return isRecord(value) && typeof value.msg === "string";
}

function describeLoc(loc: unknown): string | null {
  if (!Array.isArray(loc)) return null;
  const parts = loc.filter((p) => typeof p === "string" || typeof p === "number");
  return parts.length > 0 ? parts.join(".") : null;
}

/**
 * Normalize any of the three documented error-body shapes into `{ message, code, errors }`.
 *
 * Unknown shapes fall back to the raw string body, then to `HTTP <status>`.
 */
export function parseErrorBody(body: unknown, status?: number): ParsedErrorBody {
  const fallback = status ? `HTTP ${status}` : "Unknown error";

  if (typeof body === "string") {
    const trimmed = body.trim();
    return { message: trimmed.length > 0 ? trimmed : fallback, code: null, errors: null };
  }

  if (isRecord(body)) {
    // Form A — gateway 401: { error, message, code }
    if (typeof body.message === "string" && ("error" in body || "code" in body)) {
      return {
        message: body.message,
        code: typeof body.code === "string" ? body.code : null,
        errors: null,
      };
    }

    const detail = body.detail;

    // Form B — HTTPException: { detail: "..." }
    if (typeof detail === "string") {
      return { message: detail, code: null, errors: null };
    }

    // Form C — validation: { detail: [{ loc, msg, type }] }
    if (Array.isArray(detail)) {
      const errors = detail.filter(isValidationItem);
      const summary = errors
        .map((item) => {
          const loc = describeLoc(item.loc);
          return loc ? `${loc}: ${item.msg}` : item.msg;
        })
        .join("; ");
      return {
        message: summary.length > 0 ? summary : fallback,
        code: null,
        errors: errors.length > 0 ? errors : null,
      };
    }

    // Some upstreams answer with a bare { error: "..." } object.
    if (typeof body.error === "string") {
      return {
        message: body.error,
        code: typeof body.code === "string" ? body.code : null,
        errors: null,
      };
    }
  }

  return { message: fallback, code: null, errors: null };
}

/** Extra context the transport can attach when building a status error. */
export interface StatusErrorContext {
  headers?: Headers;
  rateLimit?: RateLimitInfo | null;
  retryAfter?: number | null;
}

/** Map an HTTP status code plus response body onto the matching {@link APIStatusError} subclass. */
export function createStatusError(
  status: number,
  body: unknown,
  context: StatusErrorContext = {},
): APIStatusError {
  const parsed = parseErrorBody(body, status);
  const init: APIStatusErrorInit = {
    status,
    headers: context.headers ?? {},
    body,
    code: parsed.code,
  };

  switch (status) {
    case 400:
      return new BadRequestError(parsed.message, init);
    case 401:
      return new AuthenticationError(parsed.message, init);
    case 403:
      return new PermissionDeniedError(parsed.message, init);
    case 404:
      return new NotFoundError(parsed.message, init);
    case 422:
      return new UnprocessableEntityError(parsed.message, { ...init, errors: parsed.errors });
    case 429:
      return new RateLimitError(parsed.message, {
        ...init,
        rateLimit: context.rateLimit ?? null,
        retryAfter: context.retryAfter ?? null,
      });
    case 503:
      return new ServiceUnavailableError(parsed.message, init);
    default:
      break;
  }

  if (status >= 500) {
    return new InternalServerError(parsed.message, init);
  }
  return new APIStatusError(parsed.message, init);
}

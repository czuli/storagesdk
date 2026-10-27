import {
  isAbortError,
  StorageError,
  type StorageErrorCode,
} from '@storagesdk/core';

/**
 * Buddy reports most file-server failures as HTTP 400 with a free-text
 * message (e.g. `File server error (code: 9): path not exists`). Map the
 * well-known phrases to the matching `StorageError` code so callers get
 * `NotFound` / `Conflict` instead of a blanket `InvalidArgument`.
 */
export function codeForBadRequest(message: string): StorageErrorCode {
  const text = message.toLowerCase();
  if (text.includes('path not exists')) return 'NotFound';
  if (text.includes('does not exist')) return 'NotFound';
  if (text.includes('must be unique')) return 'Conflict';
  return 'InvalidArgument';
}

/**
 * HTTP status → `StorageError` code. Core has no dedicated code for rate
 * limiting or a temporarily unavailable backend, so `429` and `5xx` map
 * to `Provider`; the client has already retried them by the time they
 * surface here, and `BuddyApiError.retryAfterMs` says how long Buddy
 * asked us to wait.
 */
export function codeForStatus(
  status: number,
  message: string
): StorageErrorCode {
  if (status === 401 || status === 403) return 'Unauthorized';
  if (status === 404) return 'NotFound';
  if (status === 409) return 'Conflict';
  if (status === 400) return codeForBadRequest(message);
  if (status === 416 || status === 422) return 'InvalidArgument';
  return 'Provider';
}

function describeStatus(err: BuddyApiError): string {
  if (err.status === 429) {
    const wait =
      err.retryAfterMs !== undefined
        ? `, retry after ${Math.ceil(err.retryAfterMs / 1000)}s`
        : '';
    return `rate limited by Buddy (429${wait}): ${err.message}`;
  }
  if (err.status >= 500) {
    return `Buddy unavailable (${err.status}): ${err.message}`;
  }
  return err.message;
}

/** Pull the first human-readable message out of a Buddy error body. */
export function messageFromBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      errors?: { message?: string }[];
      message?: string;
    };
    const first = parsed.errors?.[0]?.message ?? parsed.message;
    return typeof first === 'string' && first.length > 0 ? first : undefined;
  } catch {
    return body.trim().length > 0 ? body.trim() : undefined;
  }
}

/** HTTP-level failure from the Buddy REST API. */
export class BuddyApiError extends Error {
  readonly status: number;
  /** Parsed `Retry-After` header, when Buddy sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'BuddyApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Map any error raised while talking to the Buddy API to a `StorageError`.
 * `BuddyApiError` carries the HTTP status; everything else (network, abort,
 * JSON parse) falls back to `Provider` or `Aborted`.
 */
export function asStorageError(err: unknown, path?: string): StorageError {
  if (err instanceof StorageError) return err;

  const cause = err instanceof Error ? err : undefined;
  if (isAbortError(err)) {
    return new StorageError({ code: 'Aborted', cause });
  }
  if (err instanceof BuddyApiError) {
    const message = describeStatus(err);
    return new StorageError({
      code: codeForStatus(err.status, err.message),
      message: path ? `${path}: ${message}` : message,
      cause,
    });
  }
  return new StorageError({
    code: 'Provider',
    message:
      err instanceof Error
        ? path
          ? `${path}: ${err.message}`
          : err.message
        : path
          ? `${path} failed`
          : 'Buddy error',
    cause,
  });
}

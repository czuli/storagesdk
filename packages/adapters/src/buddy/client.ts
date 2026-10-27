import { isAbortError, StorageError } from '@storagesdk/core';
import { BuddyApiError, messageFromBody } from './errors.js';

/** One artifact version as returned by the Buddy REST API. */
export interface BuddyVersion {
  id: string;
  version: string;
  size: number;
  created_date: string;
  note?: string;
  version_url?: string;
}

/** One entry of a version's directory listing. */
export interface BuddyEntry {
  type: 'FILE' | 'DIR';
  name: string;
  path: string;
  size?: number;
  /** `sha256:<hex>` for files; absent on directories. */
  checksum?: string;
}

export interface BuddyArtifact {
  id: string;
  name: string;
  identifier: string;
  scope: 'WORKSPACE' | 'PROJECT' | 'ENVIRONMENT';
}

export interface RequestOptions {
  query?: Record<string, string | undefined>;
  json?: unknown;
  form?: FormData;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface BuddyRetryOptions {
  /**
   * Total attempts per request, including the first. `1` disables
   * retries. Defaults to 5.
   */
  maxAttempts?: number;
  /** Backoff base: attempt *n* waits `baseMs * 2^(n-1)` (±25 % jitter). Defaults to 500. */
  baseMs?: number;
  /**
   * Upper bound for one wait, whether computed or taken from
   * `Retry-After`. A longer `Retry-After` fails the request immediately
   * instead of blocking the caller. Defaults to 30 000.
   */
  maxDelayMs?: number;
}

export const DEFAULT_API_URL = 'https://api.buddy.works';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

/** Statuses retried for every method: the server did not act on the request. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
/** Methods safe to repeat after a network-level failure (no response). */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'DELETE']);

/** Parse `Retry-After` (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/** Abortable `setTimeout`; rejects with `Aborted` when `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StorageError({ code: 'Aborted' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new StorageError({ code: 'Aborted' }));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Minimal authenticated `fetch` wrapper over the Buddy REST API, scoped to
 * one workspace. Every path is relative to `/workspaces/<workspace>`.
 * Non-2xx responses surface as `BuddyApiError` carrying the status and
 * the first message from Buddy's `{ errors: [{ message }] }` envelope.
 *
 * `429` and `502`–`504` are retried with exponential backoff, honouring
 * `Retry-After` when Buddy sends one (the API allows 3000 requests per
 * hour per token). Network failures are retried for idempotent methods
 * only.
 */
export class BuddyClient {
  readonly apiUrl: string;
  readonly workspace: string;
  readonly #token: string;
  readonly #maxAttempts: number;
  readonly #baseMs: number;
  readonly #maxDelayMs: number;

  constructor(
    apiUrl: string,
    workspace: string,
    token: string,
    retry: BuddyRetryOptions = {}
  ) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.workspace = workspace;
    this.#token = token;
    this.#maxAttempts = Math.max(1, retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.#baseMs = retry.baseMs ?? DEFAULT_BASE_MS;
    this.#maxDelayMs = retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  /** Absolute URL for a workspace-relative API path. */
  url(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(
      `${this.apiUrl}/workspaces/${encodeURIComponent(this.workspace)}${path}`
    );
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /** Raw request; the caller consumes the `Response` body. */
  async request(
    method: string,
    path: string,
    opts: RequestOptions = {}
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      ...opts.headers,
    };
    let body: RequestInit['body'];
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form !== undefined) {
      body = opts.form;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    if (opts.signal !== undefined) init.signal = opts.signal;
    const url = this.url(path, opts.query);

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (
          isAbortError(err) ||
          !IDEMPOTENT.has(method.toUpperCase()) ||
          attempt >= this.#maxAttempts
        ) {
          throw err;
        }
        await sleep(this.#backoff(attempt), opts.signal);
        continue;
      }
      if (res.ok) return res;

      const text = await res.text().catch(() => '');
      const error = new BuddyApiError(
        res.status,
        messageFromBody(text) ?? `${method} ${path} failed (${res.status})`,
        retryAfterMs(res.headers.get('retry-after'))
      );
      if (!RETRY_STATUSES.has(res.status) || attempt >= this.#maxAttempts) {
        throw error;
      }
      const wait = error.retryAfterMs ?? this.#backoff(attempt);
      if (wait > this.#maxDelayMs) throw error;
      await sleep(wait, opts.signal);
    }
  }

  /** JSON request; `204 No Content` resolves to `undefined`. */
  async json<T>(
    method: string,
    path: string,
    opts: RequestOptions = {}
  ): Promise<T> {
    const res = await this.request(method, path, opts);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  #backoff(attempt: number): number {
    const exp = this.#baseMs * 2 ** (attempt - 1);
    const jitter = 0.75 + Math.random() * 0.5;
    return Math.min(this.#maxDelayMs, Math.round(exp * jitter));
  }
}

/** Percent-encode a slash-separated object path for use in an API URL. */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

import { StorageError } from '@storagesdk/core';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { buddy } from '../../src/buddy/buddy.js';
import {
  BuddyClient,
  type BuddyEntry,
  type BuddyVersion,
  retryAfterMs,
} from '../../src/buddy/client.js';
import { buddyConfigFromEnv } from '../../src/buddy/env.js';
import {
  asStorageError,
  BuddyApiError,
  codeForBadRequest,
  codeForStatus,
  messageFromBody,
} from '../../src/buddy/errors.js';
import { storageAdapterTestSuite } from '../../src/test-suite.js';

/**
 * In-memory stand-in for the slice of the Buddy REST API the adapter uses.
 * It models the behaviours the adapter is written around:
 *
 * - versions are addressed by hash id, listed with `page`/`per_page`;
 * - `POST /versions` with `from` answers at once with an empty version
 *   and fills it "in the background" (here: after `copyDelayMs`), bumping
 *   `created_date` when done;
 * - directory listings are one level deep, carry a leading slash on
 *   `path`, and a directory survives the deletion of its last file;
 * - `DELETE .../content/<path>` on a directory removes the whole subtree;
 * - 400 with a free-text message for missing paths / duplicate names.
 */
interface MockVersion {
  id: string;
  version: string;
  created_date: string;
  files: Map<string, Uint8Array>;
  /** Directories that exist independently of files (Buddy keeps them). */
  dirs: Set<string>;
  copyFrom?: string;
}

interface MockState {
  artifactId: string;
  identifier: string;
  project: string;
  versions: Map<string, MockVersion>;
  counter: number;
  copyDelayMs: number;
  /** When set, copies never "finish" (created_date never changes). */
  stallCopies: boolean;
  /** When set, copies report the source size but never bump created_date. */
  copyBySizeOnly: boolean;
  /** Pending status overrides: consumed per matching request. */
  failures: {
    match: (method: string, url: URL) => boolean;
    status: number;
    body?: string;
    headers?: Record<string, string>;
    times: number;
  }[];
  /** Thrown instead of a response (network failure); consumed per request. */
  networkFailures: {
    match: (method: string, url: URL) => boolean;
    times: number;
  }[];
  hooks: { beforeCreateVersion?: ((name: string) => void) | undefined };
  calls: { method: string; path: string }[];
}

const state: MockState = {
  artifactId: 'art00001',
  identifier: 'mock-artifact',
  project: 'mock-project',
  versions: new Map(),
  counter: 0,
  copyDelayMs: 20,
  stallCopies: false,
  copyBySizeOnly: false,
  failures: [],
  networkFailures: [],
  hooks: {},
  calls: [],
};

function resetState(): void {
  state.versions.clear();
  state.counter = 0;
  state.copyDelayMs = 20;
  state.stallCopies = false;
  state.copyBySizeOnly = false;
  state.failures = [];
  state.networkFailures = [];
  state.hooks = {};
  state.calls = [];
}

function nowIso(): string {
  return new Date(Date.now() + ++state.counter).toISOString();
}

function sizeOf(v: MockVersion): number {
  let total = 0;
  for (const bytes of v.files.values()) total += bytes.byteLength;
  return total;
}

function versionJson(v: MockVersion): BuddyVersion {
  return {
    id: v.id,
    version: v.version,
    size: sizeOf(v),
    created_date: v.created_date,
  };
}

function checksum(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return `sha256:${(h >>> 0).toString(16).padStart(8, '0')}`;
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Directory names implied by file paths plus the explicit empty ones. */
function allDirs(v: MockVersion): Set<string> {
  const dirs = new Set(v.dirs);
  for (const file of v.files.keys()) {
    let dir = file;
    for (;;) {
      const slash = dir.lastIndexOf('/');
      if (slash < 0) break;
      dir = dir.slice(0, slash);
      dirs.add(dir);
    }
  }
  return dirs;
}

function listDir(v: MockVersion, dir: string): BuddyEntry[] | undefined {
  const dirs = allDirs(v);
  if (dir !== '' && !dirs.has(dir)) return undefined;
  const entries: BuddyEntry[] = [];
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const d of dirs) {
    if (!d.startsWith(prefix) || d === dir) continue;
    const rest = d.slice(prefix.length);
    if (rest.includes('/')) continue;
    entries.push({ type: 'DIR', name: rest, path: `/${d}` });
  }
  for (const [file, bytes] of v.files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    if (rest.includes('/')) continue;
    entries.push({
      type: 'FILE',
      name: rest,
      path: `/${file}`,
      size: bytes.byteLength,
      checksum: checksum(bytes),
    });
  }
  return entries;
}

function deletePath(v: MockVersion, path: string): boolean {
  if (v.files.delete(path)) {
    // Buddy keeps the (now possibly empty) directory around.
    const slash = path.lastIndexOf('/');
    if (slash >= 0) v.dirs.add(path.slice(0, slash));
    return true;
  }
  if (!allDirs(v).has(path)) return false;
  for (const file of [...v.files.keys()]) {
    if (file.startsWith(`${path}/`)) v.files.delete(file);
  }
  for (const d of [...v.dirs]) {
    if (d === path || d.startsWith(`${path}/`)) v.dirs.delete(d);
  }
  return true;
}

function startCopy(target: MockVersion, source: MockVersion): void {
  if (state.stallCopies) return;
  setTimeout(() => {
    target.files = new Map(source.files);
    target.dirs = new Set(source.dirs);
    if (!state.copyBySizeOnly) target.created_date = nowIso();
  }, state.copyDelayMs);
}

const decodeSegment = (segment: string): string => decodeURIComponent(segment);

async function handle(
  method: string,
  url: URL,
  init: RequestInit
): Promise<Response> {
  const parts = url.pathname.split('/').slice(1).map(decodeSegment);
  // /workspaces/:ws/artifacts[...]
  if (parts[0] !== 'workspaces' || parts[2] !== 'artifacts') {
    return errorResponse(404, 'unknown route');
  }
  const rest = parts.slice(3);
  state.calls.push({ method, path: rest.join('/') });

  if (rest.length === 0 && method === 'GET') {
    const project = url.searchParams.get('project_name');
    const artifacts =
      project === null || project === state.project
        ? [
            {
              id: state.artifactId,
              name: 'Mock',
              identifier: state.identifier,
              scope: 'PROJECT',
            },
          ]
        : [];
    return jsonResponse({ artifacts });
  }
  const [artifact, resource, versionId, content, ...pathParts] = rest;
  if (artifact !== state.artifactId) {
    if (artifact === state.identifier) {
      return errorResponse(404, 'Artifact not found');
    }
    return errorResponse(404, 'Artifact not found');
  }
  if (resource === undefined && method === 'GET') {
    return jsonResponse({
      id: state.artifactId,
      name: 'Mock',
      identifier: state.identifier,
      scope: 'PROJECT',
    });
  }
  if (resource !== 'versions') return errorResponse(404, 'unknown route');

  if (versionId === undefined) {
    if (method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '20');
      const all = [...state.versions.values()].map(versionJson);
      const start = (page - 1) * perPage;
      return jsonResponse({ versions: all.slice(start, start + perPage) });
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        version: string;
        from?: string;
      };
      state.hooks.beforeCreateVersion?.(body.version);
      for (const v of state.versions.values()) {
        if (v.version === body.version) {
          return errorResponse(400, 'Version name must be unique');
        }
      }
      let source: MockVersion | undefined;
      if (body.from !== undefined) {
        source = [...state.versions.values()].find(
          (v) => v.version === body.from
        );
        if (!source) return errorResponse(400, 'Source version does not exist');
      }
      const created: MockVersion = {
        id: `v${String(++state.counter).padStart(5, '0')}`,
        version: body.version,
        created_date: nowIso(),
        files: new Map(),
        dirs: new Set(),
      };
      state.versions.set(created.id, created);
      if (source) startCopy(created, source);
      return jsonResponse(versionJson(created), 201);
    }
    return errorResponse(405, 'method not allowed');
  }

  const version = state.versions.get(versionId);
  if (!version) return errorResponse(404, 'Version not found');
  if (content === undefined) {
    if (method === 'GET') return jsonResponse(versionJson(version));
    if (method === 'DELETE') {
      state.versions.delete(versionId);
      return new Response(null, { status: 204 });
    }
    return errorResponse(405, 'method not allowed');
  }
  if (content !== 'content') return errorResponse(404, 'unknown route');

  // .../content/download/<path> and .../content/upload/<path>
  const [kind, ...tail] = pathParts;
  if (kind === 'download' && method === 'GET') {
    const path = tail.join('/');
    const bytes = version.files.get(path);
    if (!bytes)
      return errorResponse(400, 'File server error (code: 9): path not exists');
    return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200 });
  }
  if (kind === 'upload' && method === 'POST') {
    const path = tail.join('/');
    const form = init.body as FormData;
    const file = form.get('file') as Blob;
    const bytes = new Uint8Array(await file.arrayBuffer());
    version.files.set(path, bytes);
    const slash = path.lastIndexOf('/');
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const entry: BuddyEntry = {
      type: 'FILE',
      name,
      path: `/${path}`,
      size: bytes.byteLength,
      checksum: checksum(bytes),
    };
    return jsonResponse(entry, 201);
  }
  const path = pathParts.join('/');
  if (method === 'GET') {
    const entries = listDir(version, path);
    if (!entries)
      return errorResponse(400, 'File server error (code: 9): path not exists');
    return jsonResponse({ contents: entries });
  }
  if (method === 'DELETE') {
    if (!deletePath(version, path)) {
      return errorResponse(400, 'File server error (code: 9): path not exists');
    }
    return new Response(null, { status: 204 });
  }
  return errorResponse(405, 'method not allowed');
}

const realFetch = globalThis.fetch;

async function mockFetch(
  input: string | URL | Request,
  init: RequestInit = {}
): Promise<Response> {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  );
  const method = (init.method ?? 'GET').toUpperCase();
  if (init.signal?.aborted) {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
  const network = state.networkFailures.find(
    (f) => f.times > 0 && f.match(method, url)
  );
  if (network) {
    network.times--;
    throw new TypeError('fetch failed');
  }
  const failure = state.failures.find(
    (f) => f.times > 0 && f.match(method, url)
  );
  if (failure) {
    failure.times--;
    state.calls.push({ method, path: `${failure.status} ${url.pathname}` });
    return new Response(
      failure.body ?? JSON.stringify({ errors: [{ message: 'injected' }] }),
      {
        status: failure.status,
        headers: failure.headers ?? {},
      }
    );
  }
  return handle(method, url, init);
}

beforeAll(() => {
  vi.stubGlobal('fetch', mockFetch);
});
afterAll(() => {
  vi.stubGlobal('fetch', realFetch);
  vi.unstubAllGlobals();
});

const FAST_COPY = { pollMs: 10, stepMs: 5, maxPollMs: 30, timeoutMs: 5_000 };
const NO_RETRY_WAIT = { baseMs: 1, maxDelayMs: 50 };

const adapterFactory = () =>
  buddy({
    workspace: 'mock-workspace',
    artifact: state.identifier,
    project: state.project,
    token: 'test-token',
    copy: FAST_COPY,
    retry: NO_RETRY_WAIT,
  });

storageAdapterTestSuite({
  name: 'buddy adapter (in-memory)',
  adapter: adapterFactory,
  testTimeoutMs: 20_000,
  capabilities: {
    userMetadata: false,
    contentType: false,
    presignedUploads: false,
    fetchableSignedUrls: false,
  },
});

describe('buddy adapter unit', () => {
  afterEach(() => resetState());

  const liveVersion = (): MockVersion | undefined =>
    [...state.versions.values()].find((v) => v.version === 'live');
  const versionNames = (): string[] =>
    [...state.versions.values()].map((v) => v.version).sort();
  const calls = (method: string, pattern: RegExp): number =>
    state.calls.filter((c) => c.method === method && pattern.test(c.path))
      .length;

  describe('errors', () => {
    it('maps HTTP statuses to StorageError codes', () => {
      expect(codeForStatus(401, '')).toBe('Unauthorized');
      expect(codeForStatus(403, '')).toBe('Unauthorized');
      expect(codeForStatus(404, '')).toBe('NotFound');
      expect(codeForStatus(409, '')).toBe('Conflict');
      expect(codeForStatus(416, '')).toBe('InvalidArgument');
      expect(codeForStatus(422, '')).toBe('InvalidArgument');
      expect(codeForStatus(429, '')).toBe('Provider');
      expect(codeForStatus(500, '')).toBe('Provider');
      expect(codeForStatus(503, '')).toBe('Provider');
    });

    it('reads NotFound / Conflict out of Buddy 400 messages', () => {
      expect(
        codeForBadRequest('File server error (code: 9): path not exists')
      ).toBe('NotFound');
      expect(codeForBadRequest('Version does not exist')).toBe('NotFound');
      expect(codeForBadRequest('Version name must be unique')).toBe('Conflict');
      expect(codeForBadRequest('Something else')).toBe('InvalidArgument');
      expect(codeForStatus(400, 'path NOT exists')).toBe('NotFound');
    });

    it('extracts the first message from the error envelope', () => {
      expect(
        messageFromBody('{"errors":[{"message":"first"},{"message":"second"}]}')
      ).toBe('first');
      expect(messageFromBody('{"message":"flat"}')).toBe('flat');
      expect(messageFromBody('{"errors":[]}')).toBeUndefined();
      expect(messageFromBody('  plain text  ')).toBe('plain text');
      expect(messageFromBody('')).toBeUndefined();
    });

    it('wraps BuddyApiError with status details and keeps Retry-After', () => {
      const limited = asStorageError(
        new BuddyApiError(429, 'Too many requests', 12_000),
        'a.txt'
      );
      expect(limited.code).toBe('Provider');
      expect(limited.message).toBe(
        'a.txt: rate limited by Buddy (429, retry after 12s): Too many requests'
      );
      expect((limited.cause as BuddyApiError).retryAfterMs).toBe(12_000);

      const down = asStorageError(new BuddyApiError(503, 'maintenance'));
      expect(down.message).toBe('Buddy unavailable (503): maintenance');

      const missing = asStorageError(
        new BuddyApiError(400, 'path not exists'),
        'x'
      );
      expect(missing.code).toBe('NotFound');
      expect(missing.message).toBe('x: path not exists');
    });

    it('passes StorageError through and maps aborts / unknown errors', () => {
      const original = new StorageError({ code: 'Conflict' });
      expect(asStorageError(original)).toBe(original);
      const abort = Object.assign(new Error('x'), { name: 'AbortError' });
      expect(asStorageError(abort).code).toBe('Aborted');
      expect(asStorageError(new Error('boom')).code).toBe('Provider');
      expect(asStorageError('weird', 'p').message).toBe('p failed');
    });

    it('parses Retry-After as seconds or as an HTTP date', () => {
      expect(retryAfterMs(null)).toBeUndefined();
      expect(retryAfterMs('')).toBeUndefined();
      expect(retryAfterMs('7')).toBe(7000);
      const soon = retryAfterMs(new Date(Date.now() + 5000).toUTCString());
      expect(soon).toBeGreaterThan(3000);
      expect(soon).toBeLessThanOrEqual(5000);
      expect(retryAfterMs('garbage')).toBeUndefined();
    });
  });

  describe('config', () => {
    it('rejects missing workspace / artifact / token', () => {
      expect(() => buddy({ workspace: '', artifact: 'a', token: 't' })).toThrow(
        /workspace/
      );
      expect(() => buddy({ workspace: 'w', artifact: '', token: 't' })).toThrow(
        /artifact/
      );
      expect(() => buddy({ workspace: 'w', artifact: 'a', token: '' })).toThrow(
        /token/
      );
    });

    it('reads env vars with the BUDDY_API_TOKEN fallback', () => {
      vi.stubEnv('BUDDY_WORKSPACE', 'ws');
      vi.stubEnv('BUDDY_ARTIFACT', 'art');
      vi.stubEnv('BUDDY_TOKEN', '');
      vi.stubEnv('BUDDY_API_TOKEN', 'fallback');
      vi.stubEnv('BUDDY_PROJECT', 'proj');
      vi.stubEnv('BUDDY_VERSION', '');
      vi.stubEnv('BUDDY_API_URL', 'https://api.eu.buddy.works');
      try {
        expect(buddyConfigFromEnv()).toEqual({
          workspace: 'ws',
          artifact: 'art',
          token: 'fallback',
          project: 'proj',
          apiUrl: 'https://api.eu.buddy.works',
        });
        vi.stubEnv('BUDDY_API_TOKEN', '');
        expect(() => buddyConfigFromEnv()).toThrow(/BUDDY_TOKEN/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('builds workspace-scoped URLs and encodes path segments', () => {
      const client = new BuddyClient(
        'https://api.buddy.works/',
        'my team',
        't'
      );
      expect(client.url('/artifacts', { page: '2', skip: undefined })).toBe(
        'https://api.buddy.works/workspaces/my%20team/artifacts?page=2'
      );
    });
  });

  describe('artifact and version resolution', () => {
    it('resolves an identifier through the listing when the id lookup 404s', async () => {
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'hello');
      expect(calls('GET', /^mock-artifact$/)).toBe(1);
      expect(calls('GET', /^$/)).toBe(1);
      expect(liveVersion()?.files.has('a.txt')).toBe(true);
    });

    it('fails with NotFound when the artifact is missing (never creates one)', async () => {
      const adapter = buddy({
        workspace: 'w',
        artifact: 'nope',
        token: 't',
        retry: NO_RETRY_WAIT,
      });
      await expect(adapter.list()).rejects.toMatchObject({ code: 'NotFound' });
      expect(state.versions.size).toBe(0);
    });

    it('creates the live version once and reuses it', async () => {
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'a');
      await adapter.upload('b.txt', 'b');
      expect(versionNames()).toEqual(['live']);
      expect(calls('POST', /^art00001\/versions$/)).toBe(1);
    });

    it('finds the live version beyond the first page of the listing', async () => {
      for (let i = 0; i < 120; i++) {
        const id = `old${i}`;
        state.versions.set(id, {
          id,
          version: `old-${i}`,
          created_date: nowIso(),
          files: new Map(),
          dirs: new Set(),
        });
      }
      state.versions.set('vlive', {
        id: 'vlive',
        version: 'live',
        created_date: nowIso(),
        files: new Map([['x.txt', new TextEncoder().encode('x')]]),
        dirs: new Set(),
      });
      const adapter = adapterFactory();
      expect((await adapter.list()).items.map((i) => i.path)).toEqual([
        'x.txt',
      ]);
      expect(calls('GET', /^art00001\/versions$/)).toBe(2);
      expect(calls('POST', /^art00001\/versions$/)).toBe(0);
    });

    it('recovers from losing the race to create the live version', async () => {
      state.hooks.beforeCreateVersion = (name) => {
        if (name !== 'live') return;
        state.hooks.beforeCreateVersion = undefined;
        state.versions.set('raced', {
          id: 'raced',
          version: 'live',
          created_date: nowIso(),
          files: new Map(),
          dirs: new Set(),
        });
      };
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'a');
      expect(versionNames()).toEqual(['live']);
      expect(state.versions.get('raced')?.files.has('a.txt')).toBe(true);
    });
  });

  describe('retry', () => {
    it('retries 429 honouring Retry-After and succeeds', async () => {
      state.failures.push({
        match: (m, u) => m === 'GET' && u.pathname.endsWith('/content'),
        status: 429,
        headers: { 'retry-after': '0' },
        times: 2,
      });
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'a');
      expect((await adapter.list()).items.map((i) => i.path)).toEqual([
        'a.txt',
      ]);
      expect(calls('GET', /^429 /)).toBe(2);
    });

    it('gives up after maxAttempts and reports the rate limit', async () => {
      state.failures.push({
        match: (m, u) => m === 'GET' && u.pathname.endsWith('/content'),
        status: 429,
        headers: { 'retry-after': '0' },
        times: 10,
      });
      const adapter = buddy({
        workspace: 'w',
        artifact: state.identifier,
        token: 't',
        copy: FAST_COPY,
        retry: { ...NO_RETRY_WAIT, maxAttempts: 3 },
      });
      await adapter.upload('a.txt', 'a');
      await expect(adapter.list()).rejects.toMatchObject({
        code: 'Provider',
        message: /rate limited by Buddy \(429, retry after 0s\)/,
      });
      expect(calls('GET', /^429 /)).toBe(3);
    });

    it('does not wait for a Retry-After longer than maxDelayMs', async () => {
      state.failures.push({
        match: (m, u) => m === 'GET' && u.pathname.endsWith('/content'),
        status: 429,
        headers: { 'retry-after': '1008' },
        times: 10,
      });
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'a');
      const started = Date.now();
      await expect(adapter.list()).rejects.toMatchObject({
        message: /retry after 1008s/,
      });
      expect(Date.now() - started).toBeLessThan(500);
      expect(calls('GET', /^429 /)).toBe(1);
    });

    it('retries 503 and network failures for reads, not network failures for writes', async () => {
      state.failures.push({
        match: (m, u) =>
          m === 'POST' && u.pathname.includes('/content/upload/'),
        status: 503,
        times: 1,
      });
      state.networkFailures.push({
        match: (m, u) =>
          m === 'GET' && u.pathname.includes('/content/download/'),
        times: 1,
      });
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'a');
      expect(
        new TextDecoder().decode((await adapter.download('a.txt')).body)
      ).toBe('a');

      state.networkFailures.push({
        match: (m, u) =>
          m === 'POST' && u.pathname.includes('/content/upload/'),
        times: 1,
      });
      await expect(adapter.upload('b.txt', 'b')).rejects.toMatchObject({
        code: 'Provider',
        message: 'b.txt: fetch failed',
      });
    });

    it('does not retry 4xx client errors', async () => {
      state.failures.push({
        match: (m, u) => m === 'GET' && u.pathname.endsWith('/content'),
        status: 403,
        times: 5,
      });
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'a');
      await expect(adapter.list()).rejects.toMatchObject({
        code: 'Unauthorized',
      });
      expect(calls('GET', /^403 /)).toBe(1);
    });

    it('stops retrying when the signal aborts during the backoff', async () => {
      state.failures.push({
        match: (m, u) => m === 'GET' && u.pathname.endsWith('/content'),
        status: 429,
        headers: { 'retry-after': '1' },
        times: 10,
      });
      const adapter = buddy({
        workspace: 'w',
        artifact: state.identifier,
        token: 't',
        retry: { baseMs: 1, maxDelayMs: 5_000 },
      });
      await adapter.upload('a.txt', 'a');
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      await expect(
        adapter.list({ signal: controller.signal })
      ).rejects.toMatchObject({
        code: 'Aborted',
      });
      expect(calls('GET', /^429 /)).toBe(1);
    });
  });

  describe('version copy polling', () => {
    it('finishes on created_date change and grows the poll interval', async () => {
      state.copyDelayMs = 60;
      const adapter = buddy({
        workspace: 'w',
        artifact: state.identifier,
        token: 't',
        copy: { pollMs: 10, stepMs: 10, maxPollMs: 25, timeoutMs: 5_000 },
      });
      await adapter.upload('a.txt', 'a');
      const snap = await adapter.snapshots.create();
      // 10 + 20 + 25 + 25 ≥ 60 ms → at most 4 polls (plus the pre-copy GET of the source).
      expect(calls('GET', /^art00001\/versions\/v\d+$/)).toBeLessThanOrEqual(5);
      expect(versionNames()).toEqual(['live', snap.id]);
      expect(
        await adapter.snapshots
          .get(snap.id)
          .download('a.txt')
          .then((i) => i.size)
      ).toBe(1);
    });

    it('falls back to the size check when created_date never changes', async () => {
      state.copyBySizeOnly = true;
      state.copyDelayMs = 0;
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'abc');
      const snap = await adapter.snapshots.create();
      // third poll compares sizes
      expect(calls('GET', /^art00001\/versions\/v\d+$/)).toBe(4);
      expect(
        await adapter.snapshots
          .get(snap.id)
          .download('a.txt')
          .then((i) => i.size)
      ).toBe(3);
    });

    it('times out, reports Provider and removes the half-made version', async () => {
      state.stallCopies = true;
      const adapter = buddy({
        workspace: 'w',
        artifact: state.identifier,
        token: 't',
        copy: { pollMs: 5, stepMs: 0, maxPollMs: 5, timeoutMs: 40 },
      });
      await adapter.upload('a.txt', 'a');
      await expect(adapter.snapshots.create()).rejects.toMatchObject({
        code: 'Provider',
        message: /did not finish within 0s/,
      });
      expect(versionNames()).toEqual(['live']);
      expect(await adapter.snapshots.list()).toEqual([]);
    });

    it('aborts a pending copy and cleans up', async () => {
      state.stallCopies = true;
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'a');
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 15);
      await expect(
        adapter.forks.create({ name: 'f1', signal: controller.signal })
      ).rejects.toMatchObject({ code: 'Aborted' });
      expect(versionNames()).toEqual(['live']);
    });
  });

  describe('delete', () => {
    it('removes a file and prunes emptied ancestor directories', async () => {
      const adapter = adapterFactory();
      await adapter.upload('a/b/c.txt', 'c');
      await adapter.upload('a/keep.txt', 'k');
      state.calls = [];
      await adapter.delete('a/b/c.txt');
      const live = liveVersion();
      expect([...(live?.files.keys() ?? [])]).toEqual(['a/keep.txt']);
      expect(allDirs(live as MockVersion)).toEqual(new Set(['a']));
      // one listing of a/b, one DELETE of the directory, one listing of a
      expect(calls('DELETE', /content\/a\/b$/)).toBe(1);
      expect(calls('DELETE', /content\/a$/)).toBe(0);

      await adapter.delete('a/keep.txt');
      expect(allDirs(liveVersion() as MockVersion).size).toBe(0);
    });

    it('deletes only the file when siblings remain, and root files directly', async () => {
      const adapter = adapterFactory();
      await adapter.upload('d/one.txt', '1');
      await adapter.upload('d/two.txt', '2');
      await adapter.upload('top.txt', 't');
      state.calls = [];
      await adapter.delete('d/one.txt');
      await adapter.delete('top.txt');
      expect(calls('DELETE', /content\/d\/one\.txt$/)).toBe(1);
      expect(calls('DELETE', /content\/top\.txt$/)).toBe(1);
      expect(calls('DELETE', /content\/d$/)).toBe(0);
      expect([...(liveVersion()?.files.keys() ?? [])]).toEqual(['d/two.txt']);
    });

    it('never issues DELETE for a directory path or a missing file', async () => {
      const adapter = adapterFactory();
      await adapter.upload('dir/file.txt', 'x');
      state.calls = [];
      await adapter.delete('dir');
      await adapter.delete('dir/missing.txt');
      expect(calls('DELETE', /./)).toBe(0);
      expect(liveVersion()?.files.has('dir/file.txt')).toBe(true);
    });
  });

  describe('forks and snapshots', () => {
    it('names fork versions after the parent and hashes unsafe names', async () => {
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'a');
      await adapter.forks.create({ name: 'feature.1' });
      await adapter.forks.create({ name: 'spaces are not allowed' });
      const names = versionNames();
      expect(names).toContain('live-fork-feature.1');
      expect(names.some((n) => /^live-fork-[0-9a-f]{32}$/.test(n))).toBe(true);
      expect(
        new TextDecoder().decode(
          (await adapter.forks.get('spaces are not allowed').download('a.txt'))
            .body
        )
      ).toBe('a');
    });

    it('rolls back the fork version when the copy fails after creation', async () => {
      state.stallCopies = true;
      const adapter = buddy({
        workspace: 'w',
        artifact: state.identifier,
        token: 't',
        copy: { pollMs: 5, stepMs: 0, maxPollMs: 5, timeoutMs: 30 },
      });
      await adapter.upload('a.txt', 'a');
      const snap = await adapter.snapshots.create().catch(() => undefined);
      expect(snap).toBeUndefined();
      await expect(adapter.forks.create({ name: 'f1' })).rejects.toMatchObject({
        code: 'Provider',
      });
      expect(versionNames()).toEqual(['live']);
      expect(await adapter.forks.list()).toEqual([]);
    });

    it('snapshots.delete refuses ids outside the manifest, so live is safe', async () => {
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'a');
      await expect(adapter.snapshots.delete('live')).rejects.toMatchObject({
        code: 'NotFound',
      });
      await expect(adapter.snapshots.delete('nope')).rejects.toMatchObject({
        code: 'NotFound',
      });
      expect(versionNames()).toEqual(['live']);
      expect((await adapter.list()).items.map((i) => i.path)).toEqual([
        'a.txt',
      ]);
    });

    it('reading an unknown fork or snapshot fails with NotFound and creates nothing', async () => {
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'a');
      await expect(adapter.forks.get('nope').list()).rejects.toMatchObject({
        code: 'NotFound',
      });
      await expect(
        adapter.forks.get('nope').upload('b.txt', 'b')
      ).rejects.toMatchObject({ code: 'NotFound' });
      await expect(adapter.snapshots.get('nope').list()).rejects.toMatchObject({
        code: 'NotFound',
      });
      await adapter.forks.create({ name: 'f1' });
      await expect(
        adapter.forks.get('f1').snapshots.get('nope').list()
      ).rejects.toMatchObject({ code: 'NotFound' });
      // Core snapshots the live tree before every fork, so exactly one
      // snapshot version is expected next to the fork; nothing else appeared.
      const names = versionNames();
      expect(names).toHaveLength(3);
      expect(names).toContain('live');
      expect(names).toContain('live-fork-f1');
      expect(names.some((n) => n.startsWith('live-snapshot-'))).toBe(true);
    });

    it('snapshot views are read-only', async () => {
      const adapter = adapterFactory();
      await adapter.upload('a.txt', 'a');
      const snap = await adapter.snapshots.create();
      const view = adapter.snapshots.get(snap.id) as unknown as {
        upload?: (p: string, b: string) => Promise<unknown>;
      };
      expect(view.upload).toBeUndefined();
      expect(
        (await adapter.snapshots.get(snap.id).list()).items.map((i) => i.path)
      ).toEqual(['a.txt']);
    });
  });

  describe('download', () => {
    it('slices ranges locally and reports the whole-file checksum as etag', async () => {
      const adapter = adapterFactory();
      await adapter.upload('r.txt', 'hello world');
      const item = await adapter.download('r.txt', {
        range: { offset: 6, length: 5 },
      });
      expect(new TextDecoder().decode(item.body)).toBe('world');
      expect(item.etag).toMatch(/^sha256:[0-9a-f]{64}$/);
      await expect(
        adapter.download('r.txt', { range: { offset: 11, length: 1 } })
      ).rejects.toMatchObject({ code: 'InvalidArgument' });
    });

    it('url() points at the REST download endpoint', async () => {
      const adapter = adapterFactory();
      await adapter.upload('u/v w.txt', 'x');
      expect(await adapter.url('u/v w.txt')).toBe(
        'https://api.buddy.works/workspaces/mock-workspace/artifacts/art00001/versions/v00001/content/download/u/v%20w.txt'
      );
    });
  });
});

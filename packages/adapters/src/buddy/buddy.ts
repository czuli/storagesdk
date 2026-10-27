import {
  type Adapter,
  bodyToBytes,
  checkSignal,
  defaultDiff,
  defaultMerge,
  defaultRebase,
  defineAdapter,
  emptyManifest,
  type ForkInfo,
  isInternalKey,
  type ListOptions,
  type ListResult,
  type Manifest,
  nextSnapshotId,
  type ReadOnlyAdapter,
  readManifest,
  type SnapshotInfo,
  StorageError,
  type StorageItem,
  type StorageItemMeta,
  writeManifest,
} from '@storagesdk/core/adapter';
import {
  type BuddyArtifact,
  BuddyClient,
  type BuddyEntry,
  type BuddyRetryOptions,
  type BuddyVersion,
  DEFAULT_API_URL,
  encodePath,
  sleep,
} from './client.js';
import { asStorageError } from './errors.js';

export interface BuddyCopyOptions {
  /**
   * First wait before checking whether a version copy (snapshot / fork)
   * has landed, in milliseconds. Each further wait grows by `stepMs` up to
   * `maxPollMs`. Defaults to 1000.
   */
  pollMs?: number;
  /** Growth of the poll interval per tick. Defaults to 500. */
  stepMs?: number;
  /** Longest wait between two polls. Defaults to 3000. */
  maxPollMs?: number;
  /** Give up on a copy after this long. Defaults to 600 000 (10 min). */
  timeoutMs?: number;
}

export interface BuddyConfig {
  /** Workspace domain, e.g. `my-team` from `app.buddy.works/my-team`. */
  workspace: string;
  /**
   * Artifact to operate on — its hash id (`2xjoGwj4`) or its identifier
   * (`my-artifact`). Identifiers are resolved by listing the workspace's
   * artifacts, narrowed to `project` when set. The artifact must exist.
   */
  artifact: string;
  /** Personal access token (or OAuth token) with artifact management scope. */
  token: string;
  /** Project name — only needed to resolve a project-scoped identifier. */
  project?: string;
  /**
   * Name of the artifact version that holds the live tree. Created on
   * first use if missing. Defaults to `live`.
   */
  version?: string;
  /**
   * API base URL. Defaults to `https://api.buddy.works`; EU workspaces use
   * `https://api.eu.buddy.works`, on-premises installs their own host.
   */
  apiUrl?: string;
  /**
   * Retry policy for `429` / `5xx` responses and network failures. The
   * defaults (5 attempts, exponential backoff from 500 ms, `Retry-After`
   * honoured up to 30 s) suit the 3000 requests/hour token limit.
   */
  retry?: BuddyRetryOptions;
  /** Polling policy for server-side version copies (snapshots and forks). */
  copy?: BuddyCopyOptions;
}

/** Escape hatch: the authenticated REST client plus resolved identifiers. */
export interface BuddyRaw {
  readonly client: BuddyClient;
  readonly workspace: string;
  readonly artifact: string;
  readonly version: string;
}

const DEFAULT_VERSION = 'live';
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * Version-copy polling defaults. A snapshot of a few MB lands in roughly
 * 8–10 s and a fork made directly from the live tree (two copies) in
 * about 20 s; the interval starts short to catch quick copies and grows
 * so long ones cost fewer requests against the hourly token limit.
 */
const COPY_POLL_MS = 1000;
const COPY_POLL_STEP_MS = 500;
const COPY_POLL_MAX_MS = 3000;
/** Every N polls, fall back to comparing source/destination sizes. */
const COPY_SIZE_CHECK_EVERY = 3;
/** Give up waiting for a version copy after this long. */
const COPY_TIMEOUT_MS = 10 * 60 * 1000;

const VERSIONS_PER_PAGE = 100;

/**
 * Shared, lazily-resolved state for one adapter and every snapshot/fork
 * view derived from it. The artifact id is resolved once; version ids are
 * cached by name and dropped when the adapter deletes the version.
 */
interface Context {
  client: BuddyClient;
  config: BuddyConfig;
  copy: Required<BuddyCopyOptions>;
  artifactId: Promise<string> | undefined;
  versionIds: Map<string, string>;
}

/**
 * Buddy artifacts adapter.
 *
 * One Buddy artifact is one storagesdk location. The live tree lives in a
 * single artifact version (`config.version`, default `live`); snapshots and
 * forks are further versions of the same artifact, created with Buddy's
 * server-side version copy. The SDK manifest (`.storagesdk.metadata.json`)
 * is stored as a regular file at the root of each writable version and
 * hidden from `list()`.
 */
export function buddy(config: BuddyConfig): Adapter<BuddyRaw> {
  if (!config.workspace) {
    throw new StorageError({
      code: 'InvalidArgument',
      message: 'buddy: workspace is required',
    });
  }
  if (!config.artifact) {
    throw new StorageError({
      code: 'InvalidArgument',
      message: 'buddy: artifact is required',
    });
  }
  if (!config.token) {
    throw new StorageError({
      code: 'InvalidArgument',
      message: 'buddy: token is required',
    });
  }
  const ctx: Context = {
    client: new BuddyClient(
      config.apiUrl ?? DEFAULT_API_URL,
      config.workspace,
      config.token,
      config.retry ?? {}
    ),
    config,
    copy: {
      pollMs: config.copy?.pollMs ?? COPY_POLL_MS,
      stepMs: config.copy?.stepMs ?? COPY_POLL_STEP_MS,
      maxPollMs: config.copy?.maxPollMs ?? COPY_POLL_MAX_MS,
      timeoutMs: config.copy?.timeoutMs ?? COPY_TIMEOUT_MS,
    },
    artifactId: undefined,
    versionIds: new Map(),
  };
  return defineAdapter(impl(ctx, config.version ?? DEFAULT_VERSION, true));
}

/** Strip the leading slash Buddy puts on every listed path. */
function fromApiPath(path: string): string {
  return path.replace(/^\/+/, '');
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Parent directory of a path; `''` for top-level entries. */
function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(0, slash) : '';
}

function metaFromEntry(entry: BuddyEntry, path: string): StorageItemMeta {
  return {
    path,
    size: entry.size ?? 0,
    contentType: DEFAULT_CONTENT_TYPE,
    etag: entry.checksum ?? '',
    // Buddy's listing carries no per-file mtime. Epoch zero makes the
    // SDK's merge/rebase fall back to etag comparison (see `computeDiff`).
    lastModified: new Date(0),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as Uint8Array<ArrayBuffer>
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

/**
 * Version name for a fork. Plain names are embedded verbatim so the
 * version is recognizable in the Buddy UI; anything else is hashed so
 * the name stays a valid, bounded identifier.
 */
async function forkVersionName(parent: string, name: string): Promise<string> {
  if (/^[A-Za-z0-9._-]{1,80}$/.test(name)) return `${parent}-fork-${name}`;
  const hash = await sha256Hex(new TextEncoder().encode(name));
  return `${parent}-fork-${hash.slice(0, 32)}`;
}

async function resolveArtifactId(ctx: Context): Promise<string> {
  if (ctx.artifactId === undefined) {
    ctx.artifactId = lookupArtifactId(ctx).catch((err) => {
      // Let the next call retry instead of caching a transient failure.
      ctx.artifactId = undefined;
      throw err;
    });
  }
  return ctx.artifactId;
}

async function lookupArtifactId(ctx: Context): Promise<string> {
  const { client, config } = ctx;
  try {
    const found = await client.json<BuddyArtifact>(
      'GET',
      `/artifacts/${encodeURIComponent(config.artifact)}`
    );
    return found.id;
  } catch (err) {
    if (asStorageError(err).code !== 'NotFound') throw asStorageError(err);
  }
  let listed: { artifacts: BuddyArtifact[] };
  try {
    listed = await client.json<{ artifacts: BuddyArtifact[] }>(
      'GET',
      '/artifacts',
      { query: { project_name: config.project } }
    );
  } catch (err) {
    throw asStorageError(err);
  }
  const match = listed.artifacts.find(
    (a) => a.identifier === config.artifact || a.id === config.artifact
  );
  if (!match) {
    throw new StorageError({
      code: 'NotFound',
      message: `buddy: artifact ${config.artifact} not found in workspace ${config.workspace}${config.project ? ` (project ${config.project})` : ''}`,
    });
  }
  return match.id;
}

async function listVersions(
  ctx: Context,
  signal?: AbortSignal
): Promise<BuddyVersion[]> {
  const artifactId = await resolveArtifactId(ctx);
  const all: BuddyVersion[] = [];
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    checkSignal(signal);
    let res: { versions: BuddyVersion[] };
    try {
      res = await ctx.client.json<{ versions: BuddyVersion[] }>(
        'GET',
        `/artifacts/${artifactId}/versions`,
        {
          query: { page: String(page), per_page: String(VERSIONS_PER_PAGE) },
          ...(signal ? { signal } : {}),
        }
      );
    } catch (err) {
      throw asStorageError(err);
    }
    let fresh = 0;
    for (const v of res.versions) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      all.push(v);
      fresh++;
    }
    // Stop on a short page, or when the backend ignored paging and handed
    // us the same rows again.
    if (res.versions.length < VERSIONS_PER_PAGE || fresh === 0) break;
  }
  for (const v of all) ctx.versionIds.set(v.version, v.id);
  return all;
}

async function getVersion(
  ctx: Context,
  id: string,
  signal?: AbortSignal
): Promise<BuddyVersion> {
  const artifactId = await resolveArtifactId(ctx);
  try {
    return await ctx.client.json<BuddyVersion>(
      'GET',
      `/artifacts/${artifactId}/versions/${id}`,
      signal ? { signal } : {}
    );
  } catch (err) {
    throw asStorageError(err);
  }
}

/**
 * Version name → id. Names are the stable handle (snapshot ids and fork
 * names map to version names); Buddy addresses versions by hash id only.
 * `create` makes the version when missing — used for the live tree.
 */
async function resolveVersionId(
  ctx: Context,
  name: string,
  opts: { create?: boolean; signal?: AbortSignal } = {}
): Promise<string> {
  const cached = ctx.versionIds.get(name);
  if (cached !== undefined) return cached;
  await listVersions(ctx, opts.signal);
  const found = ctx.versionIds.get(name);
  if (found !== undefined) return found;
  if (!opts.create) {
    throw new StorageError({
      code: 'NotFound',
      message: `buddy: version ${name} not found`,
    });
  }
  const artifactId = await resolveArtifactId(ctx);
  try {
    const created = await ctx.client.json<BuddyVersion>(
      'POST',
      `/artifacts/${artifactId}/versions`,
      {
        json: { version: name },
        ...(opts.signal ? { signal: opts.signal } : {}),
      }
    );
    ctx.versionIds.set(name, created.id);
    return created.id;
  } catch (err) {
    const mapped = asStorageError(err);
    if (mapped.code !== 'Conflict') throw mapped;
    // Lost a create race — somebody else made it; pick up their id.
    await listVersions(ctx, opts.signal);
    const raced = ctx.versionIds.get(name);
    if (raced !== undefined) return raced;
    throw mapped;
  }
}

/** Delete a version by name; silently succeeds when it is already gone. */
async function deleteVersionIfPresent(
  ctx: Context,
  name: string,
  signal?: AbortSignal
): Promise<void> {
  let id: string;
  try {
    id = await resolveVersionId(ctx, name, signal ? { signal } : {});
  } catch (err) {
    if (asStorageError(err).code === 'NotFound') return;
    throw asStorageError(err);
  }
  const artifactId = await resolveArtifactId(ctx);
  try {
    await ctx.client.request(
      'DELETE',
      `/artifacts/${artifactId}/versions/${id}`,
      signal ? { signal } : {}
    );
  } catch (err) {
    const mapped = asStorageError(err);
    if (mapped.code !== 'NotFound') throw mapped;
  } finally {
    ctx.versionIds.delete(name);
  }
}

async function listDirectory(
  ctx: Context,
  versionId: string,
  dir: string,
  signal?: AbortSignal
): Promise<BuddyEntry[]> {
  const artifactId = await resolveArtifactId(ctx);
  const suffix = dir === '' ? '' : `/${encodePath(dir)}`;
  try {
    const res = await ctx.client.json<{ contents?: BuddyEntry[] }>(
      'GET',
      `/artifacts/${artifactId}/versions/${versionId}/content${suffix}`,
      signal ? { signal } : {}
    );
    return res.contents ?? [];
  } catch (err) {
    const mapped = asStorageError(err, dir);
    if (mapped.code === 'NotFound') return [];
    throw mapped;
  }
}

/**
 * Create version `name` as a server-side copy of version `from` and wait
 * until the copy has landed. Buddy answers the POST immediately with an
 * empty version and fills it in the background; completion shows up as a
 * bumped `created_date`. As a safety net — e.g. a copy that finishes within
 * the same second — every few polls the destination's reported size is
 * compared with the source's.
 */
async function copyVersion(
  ctx: Context,
  name: string,
  from: string,
  signal?: AbortSignal
): Promise<BuddyVersion> {
  const artifactId = await resolveArtifactId(ctx);
  const fromId = await resolveVersionId(ctx, from, signal ? { signal } : {});
  const source = await getVersion(ctx, fromId, signal);
  let created: BuddyVersion;
  try {
    created = await ctx.client.json<BuddyVersion>(
      'POST',
      `/artifacts/${artifactId}/versions`,
      { json: { version: name, from }, ...(signal ? { signal } : {}) }
    );
  } catch (err) {
    throw asStorageError(err);
  }
  ctx.versionIds.set(name, created.id);

  const { pollMs, stepMs, maxPollMs, timeoutMs } = ctx.copy;
  const startedAt = Date.now();
  for (let tick = 1; ; tick++) {
    await sleep(Math.min(maxPollMs, pollMs + (tick - 1) * stepMs), signal);
    const now = await getVersion(ctx, created.id, signal);
    if (now.created_date !== created.created_date) return now;
    if (
      tick % COPY_SIZE_CHECK_EVERY === 0 &&
      source.size > 0 &&
      now.size === source.size
    ) {
      return now;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new StorageError({
        code: 'Provider',
        message: `buddy: copying version ${from} to ${name} did not finish within ${Math.round(timeoutMs / 1000)}s`,
      });
    }
  }
}

/**
 * Raw implementation over one artifact version. `writable` is true for the
 * live tree and forks; snapshot views get `false` and expose reads only.
 */
function impl(
  ctx: Context,
  version: string,
  writable: boolean
): Adapter<BuddyRaw> {
  const { client, config } = ctx;

  const versionId = (signal?: AbortSignal): Promise<string> =>
    resolveVersionId(ctx, version, {
      create: writable,
      ...(signal ? { signal } : {}),
    });

  const contentUrl = async (
    kind: 'content' | 'download' | 'upload',
    path: string,
    signal?: AbortSignal
  ): Promise<string> => {
    const artifactId = await resolveArtifactId(ctx);
    const id = await versionId(signal);
    const base = `/artifacts/${artifactId}/versions/${id}/content`;
    const encoded = encodePath(path);
    if (kind === 'content') return `${base}/${encoded}`;
    return `${base}/${kind}/${encoded}`;
  };

  const headEntry = async (
    path: string,
    signal?: AbortSignal
  ): Promise<BuddyEntry | undefined> => {
    const url = await contentUrl('content', path, signal);
    try {
      const res = await client.json<{ contents?: BuddyEntry[] }>(
        'GET',
        url,
        signal ? { signal } : {}
      );
      return (res.contents ?? []).find(
        (entry) => entry.type === 'FILE' && fromApiPath(entry.path) === path
      );
    } catch (err) {
      const mapped = asStorageError(err, path);
      if (mapped.code === 'NotFound') return undefined;
      throw mapped;
    }
  };

  const notFound = (path: string): StorageError =>
    new StorageError({ code: 'NotFound', message: `${path} not found` });

  const adapter: Adapter<BuddyRaw> = {
    name: 'buddy',
    raw: {
      client,
      workspace: config.workspace,
      artifact: config.artifact,
      version,
    },

    async download(path, opts): Promise<StorageItem> {
      checkSignal(opts?.signal);
      const url = await contentUrl('download', path, opts?.signal);
      let full: Uint8Array<ArrayBuffer>;
      try {
        const res = await client.request(
          'GET',
          url,
          opts?.signal ? { signal: opts.signal } : {}
        );
        full = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        throw asStorageError(err, path);
      }
      // Buddy ignores `Range` on downloads, so slice locally. The checksum
      // of the whole object doubles as the etag (same `sha256:` format as
      // the listing API).
      const etag = `sha256:${await sha256Hex(full)}`;
      let body = full;
      if (opts?.range) {
        const { offset, length } = opts.range;
        if (offset >= full.byteLength && full.byteLength > 0) {
          throw new StorageError({
            code: 'InvalidArgument',
            message: `range offset ${offset} is past the end of ${path} (${full.byteLength} bytes)`,
          });
        }
        body = full.slice(offset, offset + length);
      }
      return {
        path,
        size: body.byteLength,
        contentType: DEFAULT_CONTENT_TYPE,
        etag,
        lastModified: new Date(0),
        body,
      };
    },

    async head(path, opts): Promise<StorageItemMeta> {
      checkSignal(opts?.signal);
      const entry = await headEntry(path, opts?.signal);
      if (!entry) throw notFound(path);
      return metaFromEntry(entry, path);
    },

    async list(opts?: ListOptions): Promise<ListResult> {
      checkSignal(opts?.signal);
      const prefix = opts?.prefix ?? '';
      const limit = opts?.limit ?? 100;
      const cursor = opts?.cursor ?? '';
      const id = await versionId(opts?.signal);
      const prefixSlash = prefix.lastIndexOf('/');
      const startDirectory =
        prefixSlash >= 0 ? prefix.slice(0, prefixSlash) : '';

      /**
       * Buddy listings are directory-scoped. Walk them in global path
       * order and stop once this page has one lookahead item. Prune
       * subtrees that cannot contain the prefix and, on later pages,
       * subtrees that sort entirely before the cursor.
       */
      async function* walk(directory: string): AsyncGenerator<StorageItemMeta> {
        const entries = (
          await listDirectory(ctx, id, directory, opts?.signal)
        ).map((entry) => ({ entry, path: fromApiPath(entry.path) }));
        entries.sort((left, right) => {
          const l = left.entry.type === 'DIR' ? `${left.path}/` : left.path;
          const r = right.entry.type === 'DIR' ? `${right.path}/` : right.path;
          return l < r ? -1 : l > r ? 1 : 0;
        });
        for (const { entry, path } of entries) {
          checkSignal(opts?.signal);
          if (entry.type === 'DIR') {
            const subtree = `${path}/`;
            if (
              prefix !== '' &&
              !prefix.startsWith(subtree) &&
              !subtree.startsWith(prefix)
            ) {
              continue;
            }
            if (
              cursor !== '' &&
              subtree <= cursor &&
              !cursor.startsWith(subtree)
            ) {
              continue;
            }
            yield* walk(path);
          } else if (
            !isInternalKey(path) &&
            path.startsWith(prefix) &&
            path > cursor
          ) {
            yield metaFromEntry(entry, path);
          }
        }
      }

      const page: StorageItemMeta[] = [];
      for await (const item of walk(startDirectory)) {
        page.push(item);
        if (page.length > limit) break;
      }
      const hasMore = page.length > limit;
      if (hasMore) page.pop();
      const last = page[page.length - 1];
      return hasMore && last !== undefined
        ? { items: page, cursor: last.path }
        : { items: page };
    },

    async url(path, opts): Promise<string> {
      checkSignal(opts?.signal);
      // Buddy has no presigned URLs; the API download endpoint needs the
      // bearer token, so this is a convenience for `raw.client` users.
      return client.url(await contentUrl('download', path, opts?.signal));
    },

    async upload(path, body, opts): Promise<StorageItemMeta> {
      checkSignal(opts?.signal);
      const bytes = await bodyToBytes(body);
      const url = await contentUrl('upload', path, opts?.signal);
      const form = new FormData();
      form.append(
        'file',
        new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: opts?.contentType ?? DEFAULT_CONTENT_TYPE,
        }),
        basename(path)
      );
      let entry: BuddyEntry;
      try {
        entry = await client.json<BuddyEntry>('POST', url, {
          form,
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
      } catch (err) {
        throw asStorageError(err, path);
      }
      opts?.onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
      return metaFromEntry(entry, path);
    },

    async delete(path, opts): Promise<void> {
      checkSignal(opts?.signal);
      const signal = opts?.signal;
      const id = await versionId(signal);
      // `DELETE .../content/<dir>` removes a whole subtree, so only issue
      // it once the path is known to be a file. Missing paths are no-ops.
      const parent = dirname(path);
      const siblings = await listDirectory(ctx, id, parent, signal);
      const entry = siblings.find(
        (sibling) =>
          sibling.type === 'FILE' && fromApiPath(sibling.path) === path
      );
      if (!entry) return;
      const removeContent = async (target: string): Promise<void> => {
        const url = await contentUrl('content', target, signal);
        try {
          await client.request('DELETE', url, signal ? { signal } : {});
        } catch (err) {
          const mapped = asStorageError(err, target);
          if (mapped.code !== 'NotFound') throw mapped;
        }
      };
      // Buddy keeps a directory after its last file is removed, and every
      // directory costs `list()` one request. Remove the file together with
      // its directory when it is the only entry, then prune emptied
      // ancestors so the tree stays as small as the objects in it.
      if (parent === '' || siblings.length > 1) {
        await removeContent(path);
        return;
      }
      await removeContent(parent);
      for (let dir = dirname(parent); dir !== ''; dir = dirname(dir)) {
        checkSignal(signal);
        const entries = await listDirectory(ctx, id, dir, signal);
        if (entries.length > 0) break;
        await removeContent(dir);
      }
    },

    async copy(from, to, opts): Promise<void> {
      checkSignal(opts?.signal);
      // No server-side object copy in the artifacts API: round-trip bytes.
      const item = await adapter.download(from, opts);
      await adapter.upload(to, item.body, opts);
    },

    async move(from, to, opts): Promise<void> {
      await adapter.copy(from, to, opts);
      await adapter.delete(from, opts);
    },

    async uploadUrl(): Promise<never> {
      throw new StorageError({
        code: 'NotSupported',
        message: 'buddy: presigned uploads are not supported',
      });
    },

    snapshots: {
      async create(opts): Promise<SnapshotInfo> {
        checkSignal(opts?.signal);
        const id = nextSnapshotId(version);
        // Make sure the live version exists before asking Buddy to copy it.
        await versionId(opts?.signal);
        try {
          await copyVersion(ctx, id, version, opts?.signal);
          opts?.onProgress?.({ scanned: 1, total: 1 });
          const meta = await readManifest(adapter);
          const info: SnapshotInfo = {
            id,
            createdAt: new Date(),
            ...(opts?.name !== undefined ? { name: opts.name } : {}),
          };
          meta.snapshots.push(info);
          await writeManifest(adapter, meta);
          return info;
        } catch (err) {
          await deleteVersionIfPresent(ctx, id).catch(() => {});
          throw asStorageError(err);
        }
      },

      async list(): Promise<SnapshotInfo[]> {
        return (await readManifest(adapter)).snapshots;
      },

      async head(id, opts): Promise<SnapshotInfo> {
        checkSignal(opts?.signal);
        const meta = await readManifest(adapter);
        const found = meta.snapshots.find((s) => s.id === id);
        if (!found) {
          throw new StorageError({
            code: 'NotFound',
            message: `snapshot ${id} not found`,
          });
        }
        return found;
      },

      async delete(id, opts): Promise<void> {
        checkSignal(opts?.signal);
        const meta = await readManifest(adapter);
        meta.snapshots = meta.snapshots.filter((s) => s.id !== id);
        await deleteVersionIfPresent(ctx, id, opts?.signal);
        await writeManifest(adapter, meta);
      },

      get(id): ReadOnlyAdapter {
        const view = impl(ctx, id, false);
        return {
          download: (p, opts) => view.download(p, opts),
          head: (p, opts) => view.head(p, opts),
          list: (opts) => view.list(opts),
          url: (p, opts) => view.url(p, opts),
        };
      },
    },

    forks: {
      async create(opts): Promise<ForkInfo> {
        checkSignal(opts.signal);
        const meta = await readManifest(adapter);
        if (meta.forks.some((f) => f.name === opts.name)) {
          throw new StorageError({
            code: 'Conflict',
            message: `fork ${opts.name} already exists`,
          });
        }
        if (
          opts.fromSnapshot !== undefined &&
          !meta.snapshots.some((s) => s.id === opts.fromSnapshot)
        ) {
          throw new StorageError({
            code: 'NotFound',
            message: `snapshot ${opts.fromSnapshot} not found`,
          });
        }
        const source = opts.fromSnapshot ?? version;
        const forkVersion = await forkVersionName(version, opts.name);
        await versionId(opts.signal);
        try {
          await copyVersion(ctx, forkVersion, source, opts.signal);
          opts.onProgress?.({ copied: 1, total: 1 });
          // The copy carries the parent's manifest; replace it with the
          // fork's own (empty, pointing back at the parent).
          const forkImpl = impl(ctx, forkVersion, true);
          const forkManifest: Manifest = emptyManifest({
            location: version,
            snapshotId: opts.fromSnapshot ?? null,
          });
          await writeManifest(forkImpl, forkManifest);

          const latest = await readManifest(adapter);
          const info: ForkInfo = {
            name: opts.name,
            createdAt: new Date(),
            ...(opts.fromSnapshot !== undefined
              ? { fromSnapshot: opts.fromSnapshot }
              : {}),
          };
          latest.forks.push(info);
          await writeManifest(adapter, latest);
          return info;
        } catch (err) {
          await deleteVersionIfPresent(ctx, forkVersion).catch(() => {});
          throw asStorageError(err);
        }
      },

      async list(): Promise<ForkInfo[]> {
        return (await readManifest(adapter)).forks;
      },

      async head(name, opts): Promise<ForkInfo> {
        checkSignal(opts?.signal);
        const meta = await readManifest(adapter);
        const found = meta.forks.find((f) => f.name === name);
        if (!found) {
          throw new StorageError({
            code: 'NotFound',
            message: `fork ${name} not found`,
          });
        }
        return found;
      },

      async delete(name, opts): Promise<void> {
        checkSignal(opts?.signal);
        const meta = await readManifest(adapter);
        meta.forks = meta.forks.filter((f) => f.name !== name);
        await deleteVersionIfPresent(
          ctx,
          await forkVersionName(version, name),
          opts?.signal
        );
        await writeManifest(adapter, meta);
      },

      get(name): Adapter<BuddyRaw> {
        // Fork version names are derived deterministically from the parent
        // version and fork name, so the view resolves lazily on first use.
        // The outer `defineAdapter` wraps this exactly once.
        return lazyImpl(ctx, forkVersionName(version, name));
      },

      merge: (name, opts) => defaultMerge(adapter, name, opts),
      rebase: (name, opts) => defaultRebase(adapter, name, opts),
      diff: (name, opts) => defaultDiff(adapter, name, opts),
    },
  };

  // Snapshot views never write; `defineAdapter` only ever hands callers
  // the four read methods, but guard the raw object too.
  if (!writable) {
    const readOnly = (): never => {
      throw new StorageError({
        code: 'NotSupported',
        message: `buddy: version ${version} is a read-only snapshot`,
      });
    };
    adapter.upload = readOnly;
    adapter.delete = readOnly;
    adapter.copy = readOnly;
    adapter.move = readOnly;
  }

  return adapter;
}

/**
 * Adapter whose version name is still being computed (fork names may need
 * hashing). Every method awaits the name once, then delegates.
 */
function lazyImpl(
  ctx: Context,
  versionName: Promise<string>
): Adapter<BuddyRaw> {
  let resolved: Promise<Adapter<BuddyRaw>> | undefined;
  const target = (): Promise<Adapter<BuddyRaw>> => {
    resolved ??= versionName.then((name) => impl(ctx, name, true));
    return resolved;
  };
  const raw: BuddyRaw = {
    client: ctx.client,
    workspace: ctx.config.workspace,
    artifact: ctx.config.artifact,
    version: '',
  };
  return {
    name: 'buddy',
    raw,
    download: async (p, o) => (await target()).download(p, o),
    head: async (p, o) => (await target()).head(p, o),
    list: async (o) => (await target()).list(o),
    url: async (p, o) => (await target()).url(p, o),
    upload: async (p, b, o) => (await target()).upload(p, b, o),
    delete: async (p, o) => (await target()).delete(p, o),
    copy: async (f, t, o) => (await target()).copy(f, t, o),
    move: async (f, t, o) => (await target()).move(f, t, o),
    uploadUrl: async (p, o) => (await target()).uploadUrl(p, o),
    snapshots: {
      create: async (o) => (await target()).snapshots.create(o),
      list: async () => (await target()).snapshots.list(),
      head: async (id, o) => (await target()).snapshots.head(id, o),
      delete: async (id, o) => (await target()).snapshots.delete(id, o),
      get: (id) =>
        lazyImpl(
          ctx,
          versionName.then(() => id)
        ),
    },
    forks: {
      create: async (o) => (await target()).forks.create(o),
      list: async () => (await target()).forks.list(),
      head: async (n, o) => (await target()).forks.head(n, o),
      delete: async (n, o) => (await target()).forks.delete(n, o),
      get: (n) =>
        lazyImpl(
          ctx,
          versionName.then((parent) => forkVersionName(parent, n))
        ),
      merge: async (n, o) => (await target()).forks.merge(n, o),
      rebase: async (n, o) => (await target()).forks.rebase(n, o),
      diff: async (n, o) => (await target()).forks.diff(n, o),
    },
  };
}

# @storagesdk/adapters/buddy

[Buddy Artifacts](https://buddy.works/docs/api/artifacts) adapter for storagesdk.
One Buddy artifact is one storage location; the live tree, snapshots and
forks are versions of that artifact.

```sh
npm install @storagesdk/core @storagesdk/adapters
```

```ts
import { Storage } from '@storagesdk/core';
import { buddy } from '@storagesdk/adapters/buddy';

const storage = new Storage({
  adapter: buddy({
    workspace: 'my-team',
    artifact: 'photos',
    token: process.env.BUDDY_TOKEN!,
  }),
});
```

## Configuration

```ts
buddy({
  workspace: string;   // workspace domain (app.buddy.works/<workspace>)
  artifact: string;    // artifact hash id or identifier (must already exist)
  token: string;       // personal access token with artifact management scope
  project?: string;    // project name, to resolve a project-scoped identifier
  version?: string;    // version that holds the live tree; defaults to 'live'
  apiUrl?: string;     // defaults to https://api.buddy.works; EU: https://api.eu.buddy.works
  retry?: {            // 429 / 502–504 / network failures
    maxAttempts?: number;  // attempts per request incl. the first; default 5
    baseMs?: number;       // exponential backoff base; default 500
    maxDelayMs?: number;   // cap for one wait, also for Retry-After; default 30 000
  };
  copy?: {             // polling for server-side version copies (snapshots, forks)
    pollMs?: number;       // first wait; default 1000
    stepMs?: number;       // growth per poll; default 500
    maxPollMs?: number;    // longest wait between polls; default 3000
    timeoutMs?: number;    // give up after; default 600 000
  };
})
```

Create the artifact (a bucket-type artifact, workspace or project scope) in
the Buddy app or via `POST /workspaces/<workspace>/artifacts`, then point the
adapter at it. The live version is created on first use when it does not
exist yet. Tokens come from **My ID → Personal access tokens**; the token
needs the artifact scope on the workspace.

## Environment variables

The runtime adapter registry accepts these variables:

```sh
BUDDY_WORKSPACE=my-team
BUDDY_ARTIFACT=photos
BUDDY_TOKEN=<personal-access-token>   # or BUDDY_API_TOKEN
BUDDY_PROJECT=my-project              # optional
BUDDY_VERSION=live                    # optional
BUDDY_API_URL=https://api.buddy.works # optional
```

## How it maps onto the API

- The live tree is one artifact version. Snapshots and forks are further
  versions of the same artifact, made with Buddy's server-side version
  copy (`POST /versions` with `from`). Buddy answers at once and fills the
  copy in the background; the adapter polls the version until its
  `created_date` changes (fallback: matching size), with the interval
  growing from `copy.pollMs` to `copy.maxPollMs`.
- The SDK manifest is stored as `.storagesdk.metadata.json` at the root of
  each writable version and hidden from `list()`.
- `list()` walks Buddy's one-level directory listings in path order and
  prunes subtrees outside the prefix or before the cursor. Every directory
  on the way costs one request.
- `delete()` lists the parent directory first, because
  `DELETE .../content/<path>` on a directory removes the whole subtree and
  the adapter must only ever name a file. When the file is the last entry,
  the directory is deleted instead and emptied ancestors are pruned, since
  Buddy keeps a directory after its last file is removed and every leftover
  directory makes `list()` one request more expensive.
- `copy()` and `move()` download and re-upload: the API has no in-version
  object copy.

## Notes

- **Rate limit.** The API allows 3000 requests per hour per token, reads
  included. `429` and `502`–`504` are retried with exponential backoff and
  `Retry-After` is honoured; a `Retry-After` longer than `retry.maxDelayMs`
  fails fast with a `Provider` error whose `cause.retryAfterMs` says how
  long Buddy asked for. Budget roughly: upload or download 1 request,
  `delete` 2, `head` 1, `list` 1 per directory, snapshot 5–8 (copy of ~10 s),
  fork from live 10–15 (the SDK snapshots live first, so two copies).
- **Copy latency.** A version copy takes several seconds regardless of
  size (about 8–10 s for a few MB in practice); a fork created without
  `fromSnapshot` costs two copies.
- **Concurrent deletes in one directory.** Two `delete()` calls racing on
  the last two files of a directory can each see the other file still
  present, delete only their own file and leave an empty directory behind.
  Delete the files of one directory sequentially, or delete the directory
  through `raw.client` when the whole subtree should go.
- Buddy serves no per-file content type or user metadata: `contentType` is
  always `application/octet-stream`, `metadata` is ignored, and
  `lastModified` is the epoch (the API returns no mtime). `etag` is the
  file's `sha256:` checksum.
- Ranged downloads are emulated client-side: the whole file is fetched and
  sliced (the download endpoint ignores `Range`).
- `url()` returns the REST download endpoint, which requires the bearer
  token; there are no presigned URLs and `uploadUrl()` throws
  `NotSupported`.
- Buddy reports missing paths and duplicate version names as HTTP 400 with
  a free-text message; the adapter maps the phrases `path not exists`,
  `does not exist` and `must be unique` to `NotFound` / `Conflict`.
  Anything else stays `InvalidArgument`.
- `storage.raw` exposes the authenticated REST client plus the resolved
  workspace, artifact and version names.

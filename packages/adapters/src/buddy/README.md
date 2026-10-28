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
  copy (`POST /versions` with `from`). Buddy completes the copy before it
  answers, so the new version is readable right away. The version's
  reported `size` is filled in a few seconds later and is not relied on.
- The SDK manifest is stored as `.storagesdk.metadata.json` at the root of
  each writable version and hidden from `list()`.
- `list()` walks Buddy's one-level directory listings in path order and
  prunes subtrees outside the prefix or before the cursor. Every directory
  on the way costs one request.
- `delete()` looks the path up first (`GET .../content/<path>`), because
  `DELETE .../content/<path>` on a directory removes the whole subtree and
  the adapter must only ever name a file. After the file is removed, emptied
  ancestor directories are pruned, since Buddy keeps a directory after its
  last file is removed and every leftover directory makes `list()` one
  request more expensive. Pruning is best-effort: a failed listing leaves
  the empty directory in place and the delete still succeeds.
- `copy()` and `move()` download and re-upload: the API has no in-version
  object copy.

## Notes

- **Rate limit.** The API allows 3000 requests per hour per token, reads
  included. `429` and `502`–`504` are retried with exponential backoff and
  `Retry-After` is honoured; a `Retry-After` longer than `retry.maxDelayMs`
  fails fast with a `Provider` error whose `cause.retryAfterMs` says how
  long Buddy asked for. Budget roughly: upload or download 1 request,
  `delete` 2 (plus one listing per directory level for nested paths and one
  `DELETE` per emptied directory), `head` 1, `list` 1 per directory, snapshot 3, fork from a
  snapshot 5, fork from live 8 (the SDK snapshots live first, so two
  copies). The first call on a new adapter adds the artifact and version
  lookups.
- **Concurrent writes in one directory.** Two `delete()` calls racing on
  the last two files of a directory can each see the other file still
  present and leave an empty directory behind. An `upload()` into a
  directory that a concurrent `delete()` has just found empty can be removed
  with it. Avoid mixing deletes and uploads in one directory in parallel, or
  delete the directory through `raw.client` when the whole subtree should go.
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

---
'@storagesdk/adapters': minor
---

Add a Buddy Artifacts adapter (`@storagesdk/adapters/buddy`). One artifact is one location; snapshots and forks are server-side copies of the live version. Requests that hit Buddy's 3000/hour token limit (`429`) or a `502`–`504` are retried with exponential backoff honouring `Retry-After`; the retry and version-copy polling policies are configurable.

# JavaScript analysis cache

`analyze_javascript_application` parses every source file of an application
in one single-threaded worker. A 13 MB Next.js build takes about a minute, and
most of that is spent on vendor chunks (React, Next.js) that rarely change
between builds. The worker now keeps its per-file results in a persistent,
content-addressed cache.

## Measured effect

Windows 11, Node 24.11.1, the `.next/static` output of a Next.js 15 app
(59 source files, 13 MB). The same Evidence ID in every pair shows the results
are identical: Evidence IDs are SHA-256 digests of the complete semantic
result.

| Scenario                                    | No cache | With cache |
| ------------------------------------------- | -------- | ---------- |
| Same build analyzed again                   | 63.4 s   | 26.6 s     |
| New build: one app chunk changed            | 59.6 s   | 33.7 s     |
| First run (cache empty, entries are stored) | ~63 s    | ~66 s      |

The remaining time is the parent's validation, graph sealing and Evidence
hashing, which always run.

## What is cached, and when it is used

| Entry    | Key                                                                  | Value                    |
| -------- | -------------------------------------------------------------------- | ------------------------ |
| static   | analyzer build, source text SHA-256, path                            | static facts             |
| semantic | the static key plus file SHA-256, byte size and semantic node budget | module facts, projection |

- The analyzer build is the package version, the Node version and the worker
  entry's size and mtime, so any rebuild starts a fresh cache.
- Only completed, admitted computations are stored. Failures and results cut
  by a budget are never stored.
- A cached result goes through the same protocol as a fresh one: the static
  checkpoint, the parent's admission and the module budget check. The parent
  validates it exactly as it validates a fresh result.
- Any cache read or write failure is a miss. A corrupted entry is deleted.

## Settings

| Variable           | Default                                            |
| ------------------ | -------------------------------------------------- |
| `REA_CACHE`        | enabled; `off` disables it                         |
| `REA_CACHE_DIR`    | `%LOCALAPPDATA%\rea\cache` or `~/.cache/rea/cache` |
| `REA_CACHE_MAX_MB` | `1024`; least recently used entries are evicted    |

Entries are gzip-compressed JSON under `<cache dir>/javascript-analysis/`,
written atomically with `0600` permissions. The test suite runs with
`REA_CACHE=off`.

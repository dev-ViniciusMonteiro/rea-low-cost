# Shared MCP daemon (opt-in)

`REA_DAEMON=1` turns `rea mcp` into a thin stdio proxy for one long-lived REA
process. MCP hosts start a new `rea mcp` for every session; without the daemon
each one loads the full runtime, converts every tool schema and probes the
providers again. With the daemon, that work happens once and later sessions
connect to an already-warm process.

## Measured effect

Windows 11, Node 24.11.1, REA 6.5.0 (207 tools), median of warm runs, from
`node scripts/bench-mcp-startup.mjs --mode both --runs 5`:

| Step                   | Direct  | Daemon (warm) |
| ---------------------- | ------- | ------------- |
| `initialize`           | 1593 ms | 99 ms         |
| `tools/list`           | 542 ms  | 102 ms        |
| `binary_session`       | 433 ms  | 52 ms         |
| First call, end to end | 2564 ms | 258 ms        |

The first daemon run pays the normal startup once (about 2–3 s). Responses are
byte-identical to direct mode (`tools/list` SHA-256 matches).

## Semantics

- **Isolation.** Every connection runs the unchanged stdio entrypoint with the
  client's own environment and its own `BinarySession`. A target opened by one
  client is not visible to another.
- **Daemon selection.** The proxy hashes the package build, the Node runtime,
  the user and every result-affecting environment variable (`REA_*`,
  `GHIDRA_*`, `JAVA_*`, `PATH`, home and temp directories, client config
  homes). Clients that differ in any of these get separate daemons. Terminal
  and session variables do not split the daemon.
- **Authentication.** The daemon listens on a per-fingerprint named pipe
  (Windows) or Unix socket inside a `0700` directory, and requires a random
  token from a `0600` state file before it serves anything.
- **Lifetime.** The daemon exits after `REA_DAEMON_IDLE_MS` (default 15 min)
  without clients. A rebuild changes the fingerprint, so new sessions start a
  fresh daemon; the old one checks its build every 30 s and exits as soon as
  it has no clients left.
- **Fallback.** If no daemon can be started or reached within
  `REA_DAEMON_START_TIMEOUT_MS` (default 120 s), the proxy serves the session
  in-process exactly as `rea mcp` does without `REA_DAEMON`.
- **Working directory.** The daemon keeps the working directory of the client
  that started it. REA tools take absolute paths, so this does not change
  results.

## Use

```sh
# MCP host configuration: add the variable to the server's environment
claude mcp add rea -e REA_DAEMON=1 -- node /path/to/rea/scripts/rea.mjs mcp

rea daemon status   # pid, uptime, active and served connections
rea daemon stop     # close all sessions cleanly and exit
```

| Variable                      | Default                                              |
| ----------------------------- | ---------------------------------------------------- |
| `REA_DAEMON`                  | unset (direct mode); `1` enables the proxy           |
| `REA_DAEMON_IDLE_MS`          | `900000`                                             |
| `REA_DAEMON_START_TIMEOUT_MS` | `120000`                                             |
| `REA_DAEMON_STATE_DIR`        | `%LOCALAPPDATA%\rea\daemon` or `~/.cache/rea/daemon` |

The daemon log is `<state dir>/<fingerprint>.log`.

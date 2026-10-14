import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, posix, win32 } from "node:path";

/**
 * Identity of one shared REA daemon. Clients whose result-affecting inputs
 * match share a daemon; any difference selects a separate daemon, so a
 * connection never runs under another client's provider configuration.
 *
 * This module is loaded by the thin MCP proxy before anything else, so it
 * imports only Node built-ins.
 */
export interface DaemonEndpoint {
  /** Stable digest of the inputs that select this daemon. */
  readonly fingerprint: string;
  /** Named pipe on Windows, Unix domain socket elsewhere. */
  readonly path: string;
  /** Private directory holding the state file and daemon log. */
  readonly stateDirectory: string;
  /** JSON state written by the daemon once it listens (pid + token). */
  readonly statePath: string;
  readonly logPath: string;
}

// Variables that REA reads directly or through providers it launches. A
// variable outside this set (terminal, session ids, editor state) does not
// change analysis results and must not split the shared daemon.
const RESULT_AFFECTING_PREFIXES = [
  "REA_",
  "GHIDRA_",
  "HOPPER_",
  "IDA",
  "JEB",
  "JAVA_",
  "JDK_",
  "PLAYWRIGHT_",
  "XDG_",
  "GEMINI_",
  "HERMES_",
  "OPENCODE_",
  "PI_",
  "DSH_",
  "BUN_",
  "QWEN_",
  "QODER_",
  "GROK_",
  "KIMI_",
  "CODEX_",
  "COPILOT_",
  "OMP_",
  "SAND_",
] as const;

const RESULT_AFFECTING_NAMES = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "NODE_OPTIONS",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CLAUDE_CONFIG_DIR",
  "PREFIX",
]);

// Daemon controls and the dispatcher-owned version never select a daemon.
const DAEMON_CONTROL = /^REA_(DAEMON|PACKAGE_VERSION)/u;

/** Return the sorted result-affecting subset of an environment. */
export const daemonEnvironmentKey = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): readonly (readonly [string, string])[] => {
  const selected = new Map<string, string>();
  for (const [rawKey, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    // Windows variable names are case-insensitive; keep the first spelling.
    const key = platform === "win32" ? rawKey.toUpperCase() : rawKey;
    if (DAEMON_CONTROL.test(key)) continue;
    const affects =
      RESULT_AFFECTING_NAMES.has(key) ||
      RESULT_AFFECTING_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (affects && !selected.has(key)) selected.set(key, value);
  }
  return [...selected.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
};

/** Build identity: a rebuilt runtime gets a fresh daemon. */
const runtimeIdentity = (packageRoot: string): string => {
  try {
    const stat = statSync(join(packageRoot, "dist", "mcp", "main.js"));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
};

const defaultStateDirectory = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string => {
  const join = platform === "win32" ? win32.join : posix.join;
  const override = environment.REA_DAEMON_STATE_DIR;
  if (override !== undefined && override !== "") return override;
  if (platform === "win32") {
    const local =
      environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(local, "rea", "daemon");
  }
  const cache = environment.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cache, "rea", "daemon");
};

export const resolveDaemonEndpoint = (input: {
  readonly packageRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}): DaemonEndpoint => {
  const platform = input.platform ?? process.platform;
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      v: 1,
      packageRoot: input.packageRoot,
      version: input.environment.REA_PACKAGE_VERSION ?? null,
      runtime: runtimeIdentity(input.packageRoot),
      node: process.execPath,
      nodeVersion: process.version,
      user: userInfo().username,
      environment: daemonEnvironmentKey(input.environment, platform),
    }),
  );
  // 16 hex characters keep Unix socket paths under the 104-byte limit.
  const fingerprint = hash.digest("hex").slice(0, 16);
  const stateDirectory = defaultStateDirectory(input.environment, platform);
  const join = platform === "win32" ? win32.join : posix.join;
  return {
    fingerprint,
    path:
      platform === "win32"
        ? `\\\\.\\pipe\\rea-daemon-${fingerprint}`
        : join(stateDirectory, `${fingerprint}.sock`),
    stateDirectory,
    statePath: join(stateDirectory, `${fingerprint}.json`),
    logPath: join(stateDirectory, `${fingerprint}.log`),
  };
};

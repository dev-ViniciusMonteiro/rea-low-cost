import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { resolveDaemonEndpoint, type DaemonEndpoint } from "./endpoint.js";
import {
  DAEMON_PROTOCOL_VERSION,
  readLine,
  writeLine,
  type DaemonReply,
  type DaemonState,
} from "./protocol.js";

/**
 * Thin MCP stdio proxy. It loads no REA analysis code: it finds (or starts)
 * the shared daemon for this client's configuration, authenticates, and then
 * copies MCP bytes between the client's stdio and the daemon socket.
 */

const DEFAULT_START_TIMEOUT_MS = 120_000;
const CONNECTION_LOST =
  "REA lost its MCP client connection. Restart REA from your MCP client.";

interface ProxyOptions {
  readonly packageRoot: string;
  readonly dispatcherPath: string;
}

const tryConnect = (path: string): Promise<Socket | undefined> =>
  new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", () => resolve(undefined));
  });

const readState = async (
  endpoint: DaemonEndpoint,
): Promise<DaemonState | undefined> => {
  try {
    return JSON.parse(
      await readFile(endpoint.statePath, "utf8"),
    ) as DaemonState;
  } catch {
    return undefined;
  }
};

/** Launch a detached daemon; false when it cannot even be started. */
const startDaemon = (
  endpoint: DaemonEndpoint,
  options: ProxyOptions,
): boolean => {
  let log: number;
  try {
    mkdirSync(endpoint.stateDirectory, { recursive: true, mode: 0o700 });
    log = openSync(endpoint.logPath, "a", 0o600);
  } catch {
    return false;
  }
  try {
    const child = spawn(
      process.execPath,
      [options.dispatcherPath, "daemon", "serve"],
      {
        detached: true,
        stdio: ["ignore", log, log],
        env: process.env,
        windowsHide: true,
      },
    );
    child.unref();
    return true;
  } catch {
    return false;
  } finally {
    closeSync(log);
  }
};

type Opened =
  | {
      readonly kind: "connected";
      readonly socket: Socket;
      readonly rest: Buffer;
      readonly reply: DaemonReply;
    }
  | { readonly kind: "rejected"; readonly reply: DaemonReply }
  | { readonly kind: "unavailable" };

/** Authenticate one connected socket; undefined means retry. */
const handshake = async (
  socket: Socket,
  endpoint: DaemonEndpoint,
  request: Record<string, unknown>,
): Promise<Opened | undefined> => {
  const state = await readState(endpoint);
  if (state === undefined) return undefined;
  writeLine(socket, {
    v: DAEMON_PROTOCOL_VERSION,
    token: state.token,
    ...request,
  });
  try {
    const { line, rest } = await readLine(socket);
    const reply = JSON.parse(line) as DaemonReply;
    if (reply.ok) return { kind: "connected", socket, rest, reply };
    // The state file can briefly lag a daemon that just took the endpoint.
    if (reply.reason !== "unauthorized") return { kind: "rejected", reply };
  } catch {
    // The daemon closed during its own startup or shutdown; retry.
  }
  return undefined;
};

/** Connect, authenticate and send one request; retries while a daemon starts. */
const open = async (
  endpoint: DaemonEndpoint,
  request: Record<string, unknown>,
  startIfMissing: ProxyOptions | undefined,
): Promise<Opened> => {
  const timeoutMs = Number(
    process.env.REA_DAEMON_START_TIMEOUT_MS ?? DEFAULT_START_TIMEOUT_MS,
  );
  const deadline = Date.now() + timeoutMs;
  let started = false;
  let wait = 25;
  while (Date.now() < deadline) {
    const socket = await tryConnect(endpoint.path);
    if (socket !== undefined) {
      const opened = await handshake(socket, endpoint, request);
      if (opened?.kind === "connected") return opened;
      socket.destroy();
      if (opened !== undefined) return opened;
    } else if (startIfMissing === undefined) {
      return { kind: "unavailable" };
    } else if (!started) {
      if (!startDaemon(endpoint, startIfMissing))
        return { kind: "unavailable" };
      started = true;
    }
    await delay(wait);
    wait = Math.min(wait * 2, 500);
  }
  return { kind: "unavailable" };
};

/**
 * Serve this MCP client through the shared daemon. Returns "fallback" when no
 * daemon could be reached, before any client byte has been read, so the
 * caller can run the in-process server instead.
 */
export const runDaemonProxy = async (
  options: ProxyOptions,
): Promise<"served" | "fallback"> => {
  const endpoint = resolveDaemonEndpoint({
    packageRoot: options.packageRoot,
    environment: process.env,
  });
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) environment[key] = value;
  const opened = await open(
    endpoint,
    { command: "connect", env: environment },
    options,
  );
  if (opened.kind === "unavailable") return "fallback";
  if (opened.kind === "rejected") {
    const reply = opened.reply;
    if (!reply.ok) {
      process.stderr.write(
        reply.stderr ?? `REA daemon refused: ${reply.reason}\n`,
      );
      process.exitCode = reply.exitCode ?? 1;
    }
    return "served";
  }
  const { socket, rest } = opened;
  if (rest.length > 0) process.stdout.write(rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
  socket.resume();
  let clientEnded = false;
  process.stdin.once("end", () => {
    clientEnded = true;
    socket.end();
  });
  socket.on("error", () => undefined);
  socket.once("close", () => {
    if (!clientEnded) {
      process.stderr.write(`${CONNECTION_LOST}\n`);
      process.exitCode = 1;
    }
    process.stdin.unpipe(socket);
    process.stdin.destroy();
  });
  return "served";
};

/** `rea daemon status|stop`: report or stop the daemon for this configuration. */
export const runDaemonCommand = async (
  command: "status" | "stop",
  options: Pick<ProxyOptions, "packageRoot">,
): Promise<number> => {
  const endpoint = resolveDaemonEndpoint({
    packageRoot: options.packageRoot,
    environment: process.env,
  });
  const opened = await open(endpoint, { command }, undefined);
  if (opened.kind === "connected") opened.socket.destroy();
  const report =
    opened.kind === "unavailable"
      ? {
          running: false,
          fingerprint: endpoint.fingerprint,
          endpoint: endpoint.path,
        }
      : opened.kind === "rejected"
        ? { running: true, error: opened.reply }
        : {
            running: command === "status",
            endpoint: endpoint.path,
            ...(opened.reply.ok ? opened.reply.status : {}),
          };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
};

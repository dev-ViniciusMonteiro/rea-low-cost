import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";

import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";

import { run } from "../main.js";
import { SERVER_START_FAILED } from "../main/messages.js";
import type { RuntimeDependencies } from "../main/types.js";
import { resolveDaemonEndpoint, type DaemonEndpoint } from "./endpoint.js";
import {
  DAEMON_PROTOCOL_VERSION,
  readLine,
  writeLine,
  type DaemonReply,
  type DaemonRequest,
  type DaemonState,
  type DaemonStatus,
} from "./protocol.js";

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 10_000;

const parsePositiveInteger = (
  value: string | undefined,
  fallback: number,
): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const sameToken = (expected: Buffer, received: unknown): boolean => {
  if (typeof received !== "string") return false;
  const candidate = Buffer.from(received, "utf8");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
};

const parseRequest = (line: string): DaemonRequest | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return undefined;
    const request = value as Record<string, unknown>;
    if (request.v !== DAEMON_PROTOCOL_VERSION) return undefined;
    if (typeof request.token !== "string") return undefined;
    if (request.command === "status" || request.command === "stop")
      return request as DaemonRequest;
    if (request.command !== "connect") return undefined;
    const env = request.env;
    if (typeof env !== "object" || env === null) return undefined;
    for (const entry of Object.values(env))
      if (typeof entry !== "string") return undefined;
    return request as DaemonRequest;
  } catch {
    return undefined;
  }
};

/** Probe a Unix socket left by a previous daemon; true when one still listens. */
const endpointIsLive = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });

const listen = async (server: Server, endpoint: DaemonEndpoint) => {
  const attempt = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.path, () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await attempt();
  } catch (cause: unknown) {
    const code = (cause as NodeJS.ErrnoException).code;
    // Windows pipes vanish with their owner; only a Unix socket file can be stale.
    if (code !== "EADDRINUSE" || process.platform === "win32") throw cause;
    if (await endpointIsLive(endpoint.path)) throw cause;
    await rm(endpoint.path, { force: true });
    await attempt();
  }
};

const log = (message: string, fields: Record<string, unknown> = {}): void => {
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, msg: message, ...fields })}\n`,
  );
};

const reply = (socket: Socket, value: DaemonReply): void =>
  writeLine(socket, value);

/**
 * Long-lived process that serves many MCP clients. Each authenticated
 * connection runs the unchanged stdio entrypoint (`run`) with the client's own
 * environment and its own BinarySession, so per-client semantics are those of
 * a dedicated `rea mcp` process; the daemon only removes the repeated startup.
 */
class ReaDaemon {
  readonly #endpoint: DaemonEndpoint;
  readonly #idleTimeoutMs: number;
  readonly #startedAt = new Date();
  readonly #token = randomBytes(32).toString("base64url");
  readonly #sockets = new Set<Socket>();
  readonly #shutdowns = new Set<() => Promise<void>>();
  readonly #server: Server;
  #servedConnections = 0;
  #stopping: Promise<void> | undefined;
  #idleTimer: NodeJS.Timeout | undefined;

  constructor(endpoint: DaemonEndpoint, idleTimeoutMs: number) {
    this.#endpoint = endpoint;
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  /** Listen, publish credentials, and resolve once the daemon has stopped. */
  async serve(): Promise<number> {
    await mkdir(this.#endpoint.stateDirectory, {
      recursive: true,
      mode: 0o700,
    });
    if (process.platform !== "win32")
      await chmod(this.#endpoint.stateDirectory, 0o700);
    // Publish the token only after this process owns the endpoint, so a second
    // daemon that loses the race never replaces the winner's credentials.
    const state: DaemonState = {
      pid: process.pid,
      token: this.#token,
      fingerprint: this.#endpoint.fingerprint,
      startedAt: this.#startedAt.toISOString(),
    };
    const pendingState = `${this.#endpoint.statePath}.${process.pid}.tmp`;
    await writeFile(pendingState, JSON.stringify(state), { mode: 0o600 });
    try {
      await listen(this.#server, this.#endpoint);
    } catch (cause: unknown) {
      await rm(pendingState, { force: true });
      if ((cause as NodeJS.ErrnoException).code === "EADDRINUSE") {
        log("another daemon already serves this endpoint");
        return 0;
      }
      log("daemon could not listen", { error: String(cause) });
      return 1;
    }
    await rename(pendingState, this.#endpoint.statePath);
    log("daemon listening", {
      fingerprint: this.#endpoint.fingerprint,
      endpoint: this.#endpoint.path,
      idleTimeoutMs: this.#idleTimeoutMs,
    });
    this.#armIdleTimer();
    const onSignal = (): void => {
      void this.stop("signal").finally(() => process.exit(0));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    await new Promise<void>((resolve) =>
      this.#server.once("close", () => resolve()),
    );
    await this.stop("closed");
    return 0;
  }

  stop(reason: string): Promise<void> {
    this.#stopping ??= (async () => {
      log("daemon stopping", { reason, activeConnections: this.#sockets.size });
      if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
      this.#server.close();
      for (const socket of this.#sockets) socket.destroy();
      const pending = Promise.allSettled(
        [...this.#shutdowns].map((close) => close()),
      );
      await Promise.race([
        pending,
        new Promise((resolve) =>
          setTimeout(resolve, SHUTDOWN_GRACE_MS).unref(),
        ),
      ]);
      await rm(this.#endpoint.statePath, { force: true });
      if (process.platform !== "win32")
        await rm(this.#endpoint.path, { force: true });
      log("daemon stopped", { reason });
    })();
    return this.#stopping;
  }

  #armIdleTimer(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      if (this.#sockets.size === 0) void this.stop("idle");
    }, this.#idleTimeoutMs);
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    socket.once("close", () => {
      this.#sockets.delete(socket);
      if (this.#sockets.size === 0 && this.#stopping === undefined)
        this.#armIdleTimer();
    });
    socket.on("error", () => socket.destroy());
    void this.#handle(socket);
  }

  #status(): DaemonStatus {
    return {
      pid: process.pid,
      fingerprint: this.#endpoint.fingerprint,
      startedAt: this.#startedAt.toISOString(),
      uptimeMs: Date.now() - this.#startedAt.getTime(),
      // The control connection asking for status is not an MCP client.
      activeConnections: this.#sockets.size - 1,
      servedConnections: this.#servedConnections,
      idleTimeoutMs: this.#idleTimeoutMs,
    };
  }

  async #handle(socket: Socket): Promise<void> {
    let opening: { line: string; rest: Buffer };
    try {
      opening = await readLine(socket);
    } catch {
      socket.destroy();
      return;
    }
    const request = parseRequest(opening.line);
    const refusal: DaemonReply | undefined =
      request === undefined
        ? { ok: false, reason: "bad_request" }
        : !sameToken(Buffer.from(this.#token), request.token)
          ? { ok: false, reason: "unauthorized" }
          : request.command === "connect" && this.#stopping !== undefined
            ? {
                ok: false,
                reason: "start_failed",
                exitCode: 1,
                stderr: "REA daemon is stopping; retry the connection.\n",
              }
            : undefined;
    if (request === undefined || refusal !== undefined) {
      reply(socket, refusal ?? { ok: false, reason: "bad_request" });
      socket.end();
      return;
    }
    if (request.command === "connect") {
      await this.#serveConnection(socket, request.env, opening.rest);
      return;
    }
    reply(socket, { ok: true, status: this.#status() });
    socket.end();
    if (request.command === "stop") void this.stop("requested");
  }

  async #serveConnection(
    socket: Socket,
    environment: Readonly<Record<string, string>>,
    rest: Buffer,
  ): Promise<void> {
    this.#servedConnections += 1;
    const connectionId = this.#servedConnections;
    // Replay bytes that arrived with the handshake, then stream the socket.
    const input = new PassThrough();
    if (rest.length > 0) input.write(rest);
    socket.pipe(input);
    socket.resume();
    const opening = { served: false, stderr: [] as string[] };
    let exitCode: number;
    try {
      exitCode = await run(
        this.#connectionDependencies(socket, input, environment, opening),
      );
    } catch {
      opening.stderr.push(`${SERVER_START_FAILED}\n`);
      exitCode = 1;
    }
    log("connection opened", {
      connectionId,
      exitCode,
      served: opening.served,
    });
    if ((exitCode !== 0 || !opening.served) && !socket.destroyed) {
      reply(socket, {
        ok: false,
        reason: "start_failed",
        exitCode: exitCode === 0 ? 1 : exitCode,
        stderr: opening.stderr.join(""),
      });
      socket.end();
    }
  }

  #connectionDependencies(
    socket: Socket,
    input: PassThrough,
    environment: Readonly<Record<string, string>>,
    opening: { served: boolean; readonly stderr: string[] },
  ): RuntimeDependencies {
    const connectionId = this.#servedConnections;
    return {
      env: { ...environment },
      serve: (factory, serveOptions) => {
        opening.served = true;
        reply(socket, { ok: true });
        return serveStdio(factory, {
          ...serveOptions,
          transport: new StdioServerTransport(input, socket),
        });
      },
      // Before serving, stderr is returned to the client like a failed start.
      writeStderr: (text) => {
        if (opening.served) log("connection stderr", { connectionId, text });
        else opening.stderr.push(text);
      },
      setExitCode: (code) => {
        if (code !== 0) log("connection exit code", { connectionId, code });
      },
      registerShutdown: (handler) => {
        socket.once("close", handler);
        return () => socket.off("close", handler);
      },
      onShutdownReady: (shutdown) => {
        this.#shutdowns.add(shutdown);
        socket.once("close", () => {
          void shutdown()
            .catch(() => undefined)
            .finally(() => this.#shutdowns.delete(shutdown));
        });
      },
    };
  }
}

export const runDaemon = (options: {
  readonly packageRoot: string;
}): Promise<number> =>
  new ReaDaemon(
    resolveDaemonEndpoint({
      packageRoot: options.packageRoot,
      environment: process.env,
    }),
    parsePositiveInteger(
      process.env.REA_DAEMON_IDLE_MS,
      DEFAULT_IDLE_TIMEOUT_MS,
    ),
  ).serve();

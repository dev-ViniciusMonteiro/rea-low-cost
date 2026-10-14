import type { Socket } from "node:net";

/**
 * Wire protocol between the thin proxy and the shared daemon. One JSON line
 * each way opens the connection; after a successful `connect` acknowledgement
 * the socket carries the MCP stdio byte stream unchanged.
 */
export const DAEMON_PROTOCOL_VERSION = 1;

/** Upper bound for the opening line (the client environment dominates it). */
export const MAX_HANDSHAKE_BYTES = 1024 * 1024;

export type DaemonRequest =
  | {
      readonly v: typeof DAEMON_PROTOCOL_VERSION;
      readonly token: string;
      readonly command: "connect";
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly v: typeof DAEMON_PROTOCOL_VERSION;
      readonly token: string;
      readonly command: "status" | "stop";
    };

export type DaemonReply =
  | { readonly ok: true; readonly status?: DaemonStatus }
  | {
      readonly ok: false;
      readonly reason: "unauthorized" | "bad_request" | "start_failed";
      readonly exitCode?: number;
      readonly stderr?: string;
    };

export interface DaemonStatus {
  readonly pid: number;
  readonly fingerprint: string;
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly activeConnections: number;
  readonly servedConnections: number;
  readonly idleTimeoutMs: number;
}

/** State file written by a listening daemon; private to the user. */
export interface DaemonState {
  readonly pid: number;
  readonly token: string;
  readonly fingerprint: string;
  readonly startedAt: string;
}

export const writeLine = (socket: Socket, value: unknown): void => {
  socket.write(`${JSON.stringify(value)}\n`);
};

/**
 * Read exactly one newline-terminated line. Bytes after the newline are
 * returned unconsumed so the MCP stream that follows is not lost.
 */
export const readLine = (
  socket: Socket,
  limit: number = MAX_HANDSHAKE_BYTES,
): Promise<{ readonly line: string; readonly rest: Buffer }> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > limit) {
          cleanup();
          reject(new Error("Daemon handshake line exceeds its limit"));
        }
        return;
      }
      cleanup();
      // Stop the flow until the caller attaches the MCP stream consumer.
      socket.pause();
      chunks.push(chunk.subarray(0, newline));
      resolve({
        line: Buffer.concat(chunks).toString("utf8"),
        rest: chunk.subarray(newline + 1),
      });
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error("Daemon connection ended before its handshake"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });

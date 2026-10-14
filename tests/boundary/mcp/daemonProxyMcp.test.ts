import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const dispatcher = resolve("scripts/rea.mjs");

const daemonEnvironment = (stateDirectory: string): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) environment[key] = value;
  return {
    ...environment,
    REA_DAEMON: "1",
    REA_DAEMON_STATE_DIR: stateDirectory,
    REA_DAEMON_IDLE_MS: "60000",
  };
};

const connectClient = async (
  environment: Record<string, string>,
  name: string,
): Promise<Client> => {
  const client = new Client({ name, version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [dispatcher, "mcp"],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  await client.connect(transport);
  onTestFinished(() => client.close());
  return client;
};

const daemonCommand = async (
  command: "status" | "stop",
  environment: Record<string, string>,
): Promise<Record<string, unknown>> => {
  const { stdout } = await execute(
    process.execPath,
    [dispatcher, "daemon", command],
    { env: environment },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
};

const sessionIsOpen = async (client: Client): Promise<unknown> => {
  const reply = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  const structured = reply.structuredContent as
    | { readonly result?: { readonly open?: unknown } }
    | undefined;
  return structured?.result?.open;
};

describe("shared daemon proxy", () => {
  it("serves concurrent MCP clients with isolated sessions", async () => {
    const stateDirectory = await createTestTempDirectory("rea-daemon-proxy-");
    const environment = daemonEnvironment(stateDirectory);
    onTestFinished(async () => {
      await daemonCommand("stop", environment);
    });

    const first = await connectClient(environment, "daemon-first");
    const second = await connectClient(environment, "daemon-second");
    const status = await daemonCommand("status", environment);
    expect(status).toMatchObject({ running: true, activeConnections: 2 });

    // The Node executable is a real native target on every supported host.
    const opened = await first.callTool({
      name: "open_binary",
      arguments: { path: process.execPath },
    });
    expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
    expect(await sessionIsOpen(first)).toBe(true);
    expect(await sessionIsOpen(second)).toBe(false);

    const [firstTools, secondTools] = await Promise.all([
      first.listTools(),
      second.listTools(),
    ]);
    expect(JSON.stringify(secondTools)).toBe(JSON.stringify(firstTools));
  }, 180_000);

  it("reports a stopped daemon after stop", async () => {
    const stateDirectory = await createTestTempDirectory("rea-daemon-stop-");
    const environment = daemonEnvironment(stateDirectory);
    const client = await connectClient(environment, "daemon-stop");
    await client.close();
    await daemonCommand("stop", environment);
    await expect(daemonCommand("status", environment)).resolves.toMatchObject({
      running: false,
    });
  }, 180_000);
});

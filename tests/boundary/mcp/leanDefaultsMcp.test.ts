import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it, onTestFinished } from "vitest";

import { COMPACT_INPUT_SCHEMA_BUDGET_BYTES } from "../../../src/config/mcpInputSchemaProfile.js";

type Candidate = {
  readonly availability: {
    readonly status: string;
    readonly diagnostics: object;
  };
  readonly target_support: { readonly diagnostics: object };
  readonly capabilities: readonly unknown[];
};

/** Production stdio server with the profile variables the suite sets removed. */
const connect = async (
  overrides: Record<string, string> = {},
): Promise<Client> => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("REA_MCP_"))
      environment[key] = value;
  delete environment.REA_DAEMON;
  const client = new Client({ name: "lean-defaults", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("scripts/rea.mjs"), "mcp"],
    cwd: process.cwd(),
    env: { ...environment, ...overrides },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  await client.connect(transport);
  onTestFinished(() => client.close());
  return client;
};

const candidates = async (
  client: Client,
  detail?: "summary" | "full",
): Promise<{ readonly items: readonly Candidate[]; readonly text: string }> => {
  const reply = await client.callTool({
    name: "binary_session",
    arguments: detail === undefined ? {} : { detail },
  });
  expect(reply.isError).not.toBe(true);
  const structured = reply.structuredContent as {
    readonly result: { readonly analysis_provider_candidates: Candidate[] };
  };
  const content = reply.content as readonly { readonly text?: string }[];
  return {
    items: structured.result.analysis_provider_candidates,
    text: content.map((part) => part.text ?? "").join(""),
  };
};

describe("lean production defaults", () => {
  it("advertises compact input schemas and no output schemas by default", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeUndefined();
      expect(
        Buffer.byteLength(JSON.stringify(tool.inputSchema)),
        tool.name,
      ).toBeLessThanOrEqual(COMPACT_INPUT_SCHEMA_BUDGET_BYTES);
    }
  }, 60_000);

  it("restores the complete advertised schemas when full is selected", async () => {
    const client = await connect({
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
    });
    const { tools } = await client.listTools();
    expect(tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
  }, 60_000);

  it("summarizes provider candidates unless full detail is requested", async () => {
    const client = await connect();
    const summary = await candidates(client);
    const full = await candidates(client, "full");
    expect(summary.items.map((item) => item.availability.status)).toEqual(
      full.items.map((item) => item.availability.status),
    );
    for (const [index, item] of summary.items.entries()) {
      expect(item.availability.diagnostics).toEqual({});
      expect(item.target_support.diagnostics).toEqual({});
      if (item.availability.status === "available")
        expect(item.capabilities).toEqual(full.items.at(index)?.capabilities);
      else expect(item.capabilities).toEqual([]);
    }
    expect(summary.text.length).toBeLessThanOrEqual(full.text.length);
  }, 60_000);
});

#!/usr/bin/env node
// Measure what an MCP client receives from REA, per field, so token work can
// be compared before and after. Token counts are estimates (4 characters per
// token); JSON usually tokenizes denser, so real counts tend to be higher.
//
//   node scripts/bench-mcp-tokens.mjs [--env KEY=VALUE ...]

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extraEnvironment = {};
for (let index = 2; index < process.argv.length; index += 1)
  if (process.argv[index] === "--env") {
    const [key, ...value] = process.argv[index + 1].split("=");
    extraEnvironment[key] = value.join("=");
    index += 1;
  }

const environment = { ...process.env, ...extraEnvironment };
delete environment.REA_DAEMON;
const child = spawn(
  process.execPath,
  [join(root, "scripts", "rea.mjs"), "mcp"],
  {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);
let buffer = "";
let nextId = 0;
const pending = new Map();
child.stderr.on("data", () => undefined);
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const message = JSON.parse(line);
      pending.get(message.id)?.({ message, bytes: line.length });
    } catch {
      // Not a protocol message.
    }
  }
});
const request = (method, params) =>
  new Promise((done) => {
    const id = ++nextId;
    pending.set(id, done);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  });

const tokens = (characters) => Math.round(characters / 4);
const row = (label, characters) =>
  console.log(
    `  ${label.padEnd(34)} ${String(characters).padStart(10)} chars  ~${String(tokens(characters)).padStart(8)} tokens`,
  );

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "rea-token-bench", version: "1" },
});
child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

const list = await request("tools/list", {});
const tools = list.message.result.tools;
const sum = (pick) => tools.reduce((total, tool) => total + pick(tool), 0);
const size = (value) =>
  value === undefined ? 0 : JSON.stringify(value).length;
console.log(
  `\nREA tools/list (${tools.length} tools) ${JSON.stringify(extraEnvironment)}`,
);
row("whole tools/list message", list.bytes);
row(
  "descriptions",
  sum((tool) => (tool.description ?? "").length),
);
row(
  "input schemas",
  sum((tool) => size(tool.inputSchema)),
);
row(
  "output schemas",
  sum((tool) => size(tool.outputSchema)),
);
row(
  "model-visible (name+desc+input)",
  sum(
    (tool) =>
      tool.name.length +
      (tool.description ?? "").length +
      size(tool.inputSchema),
  ),
);

const session = await request("tools/call", {
  name: "binary_session",
  arguments: {},
});
const result = session.message.result;
const text = result.content?.map((part) => part.text ?? "").join("") ?? "";
console.log("\nbinary_session (no target)");
row("whole message", session.bytes);
row("content text (what most hosts show)", text.length);
row("structuredContent", size(result.structuredContent));
if (result.structuredContent?.result)
  for (const [key, value] of Object.entries(result.structuredContent.result))
    if (size(value) > 1000) row(`  result.${key}`, size(value));
child.stdin.end();

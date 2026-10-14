#!/usr/bin/env node
// Measure MCP client-visible startup and first-call latency for the direct
// stdio server and for the shared daemon proxy (REA_DAEMON=1).
//
//   node scripts/bench-mcp-startup.mjs [--runs 5] [--mode direct|daemon|both]
//
// Each run starts a fresh `rea mcp` client process, as an MCP host does when
// it opens a new session. Daemon mode keeps the daemon alive across runs, so
// run 1 is the cold daemon start and later runs are warm connections.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dispatcher = join(root, "scripts", "rea.mjs");
const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const runs = Number(argValue("--runs", "5"));
const mode = argValue("--mode", "both");

const measureOnce = (environment) =>
  new Promise((resolveRun, rejectRun) => {
    const started = performance.now();
    const child = spawn(process.execPath, [dispatcher, "mcp"], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buffer = "";
    let stderr = "";
    let nextId = 0;
    const pending = new Map();
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          pending.get(message.id)?.({
            message,
            bytes: line.length,
            sha256: createHash("sha256")
              .update(line)
              .digest("hex")
              .slice(0, 16),
          });
        } catch {
          // Non-JSON output is not part of the protocol measurement.
        }
      }
    });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (pending.size > 0)
        rejectRun(new Error(`rea exited with ${code}: ${stderr.trim()}`));
    });
    const request = (method, params) =>
      new Promise((resolveRequest) => {
        const id = ++nextId;
        pending.set(id, (value) => {
          pending.delete(id);
          resolveRequest(value);
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    (async () => {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "rea-bench", version: "1" },
      });
      const initializeMs = performance.now() - started;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      let mark = performance.now();
      const list = await request("tools/list", {});
      const toolsListMs = performance.now() - mark;
      mark = performance.now();
      const session = await request("tools/call", {
        name: "binary_session",
        arguments: {},
      });
      const binarySessionMs = performance.now() - mark;
      child.stdin.end();
      resolveRun({
        initializeMs,
        toolsListMs,
        binarySessionMs,
        firstCallTotalMs: performance.now() - started,
        tools: list.message.result?.tools?.length ?? 0,
        toolsListBytes: list.bytes,
        toolsListSha256: list.sha256,
        binarySessionBytes: session.bytes,
      });
    })().catch(rejectRun);
  });

const summarize = (label, results) => {
  const pick = (key) => results.map((result) => Math.round(result[key]));
  const median = (values) =>
    [...values].sort((a, b) => a - b).at(Math.floor(values.length / 2));
  const keys = [
    "initializeMs",
    "toolsListMs",
    "binarySessionMs",
    "firstCallTotalMs",
  ];
  console.log(`\n${label} (${results.length} runs)`);
  for (const key of keys)
    console.log(
      `  ${key.padEnd(18)} first=${pick(key).at(0)}  median=${median(pick(key))}  all=[${pick(key).join(", ")}]`,
    );
  console.log(
    `  tools=${results.at(0).tools}  tools/list bytes=${results.at(0).toolsListBytes} sha256=${results.at(0).toolsListSha256}  binary_session bytes=${results.at(0).binarySessionBytes}`,
  );
};

const runMode = async (label, environment) => {
  const results = [];
  for (let run = 0; run < runs; run += 1)
    results.push(await measureOnce(environment));
  summarize(label, results);
};

const baseEnvironment = { ...process.env };
delete baseEnvironment.REA_DAEMON;
if (mode === "direct" || mode === "both")
  await runMode("direct (one server process per client)", baseEnvironment);
if (mode === "daemon" || mode === "both") {
  const daemonEnvironment = { ...baseEnvironment, REA_DAEMON: "1" };
  await runMode("daemon (thin proxy + shared daemon)", daemonEnvironment);
}

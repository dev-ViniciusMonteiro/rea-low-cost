#!/usr/bin/env node

import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Route production MCP before importing Incur. Incur owns registration helpers
// such as `mcp add`, while the MCP runtime serves the stdio tool catalog.
const args = process.argv.slice(2);
const { default: packageJson } = await import("../package.json", {
  with: { type: "json" },
});
process.env.REA_PACKAGE_VERSION = packageJson.version;
const isMcpMode =
  args.length === 1 && (args[0] === "--mcp" || args[0] === "mcp");
const isMcpDoctorMode = args[0] === "mcp" && args[1] === "doctor";
// Opt-in shared daemon: `rea mcp` becomes a thin proxy to one long-lived
// server per configuration, so new MCP sessions skip REA's startup.
const useDaemonProxy = isMcpMode && process.env.REA_DAEMON === "1";
const daemonCommand =
  args[0] === "daemon" &&
  args.length === 2 &&
  ["serve", "status", "stop"].includes(args[1])
    ? args[1]
    : undefined;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Windows home lookup throws for an empty USERPROFILE. Dependencies resolve
// home during import, before REA's own resolver can apply its account fallback.
if (process.platform === "win32" && process.env.USERPROFILE === "") {
  delete process.env.USERPROFILE;
}

// Playwright's registry assumes one of its three desktop host platforms when
// it chooses the browser cache directory. Termux reports `android`, although
// its Node runtime and filesystem are POSIX-compatible. Keep the cache path
// explicit so REA can start on Termux. Browser launch still requires a
// caller-supplied Android-compatible Chromium executable.
if (
  process.platform === "android" &&
  process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
) {
  const cacheRoot =
    process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? ".", ".cache");
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(cacheRoot, "ms-playwright");
}

const runtimeFiles = useDaemonProxy
  ? ["dist/daemon/proxy.js", "dist/mcp/main.js"]
  : daemonCommand === "serve"
    ? ["dist/mcp/daemon.js"]
    : daemonCommand !== undefined
      ? ["dist/daemon/proxy.js"]
      : isMcpMode
        ? ["dist/mcp/main.js"]
        : isMcpDoctorMode
          ? ["dist/mcp/main.js", "dist/cli-runtime/mcpDoctor.js"]
          : [
              "dist/cli-runtime/cli.js",
              "dist/cli-runtime/cliOutput.js",
              "dist/cli-runtime/cliResultOutput.js",
            ];

if (!(await compiledRuntimeExists(runtimeFiles))) {
  process.stderr.write(
    `REA's compiled runtime is missing. Run \`npm ci && npm run build:cached\` in ${packageRoot} to install dependencies and build REA, then restart it. If this is an installed package, reinstall rea-agents.\n`,
  );
  process.exitCode = 1;
} else if (daemonCommand === "serve") {
  const { runDaemon } = await import("../dist/mcp/daemon.js");
  // Provider children may hold handles after cleanup; the daemon owns exit.
  process.exit(await runDaemon({ packageRoot }));
} else if (daemonCommand !== undefined) {
  const { runDaemonCommand } = await import("../dist/daemon/proxy.js");
  process.exitCode = await runDaemonCommand(daemonCommand, { packageRoot });
} else if (useDaemonProxy) {
  const { runDaemonProxy } = await import("../dist/daemon/proxy.js");
  const outcome = await runDaemonProxy({
    packageRoot,
    dispatcherPath: fileURLToPath(import.meta.url),
  });
  if (outcome === "fallback") {
    process.stderr.write(
      "REA daemon unavailable; serving this MCP session in-process.\n",
    );
    const { runEntrypoint } = await import("../dist/mcp/main.js");
    await runEntrypoint();
  }
} else if (isMcpMode) {
  const { runEntrypoint } = await import("../dist/mcp/main.js");
  await runEntrypoint();
} else if (isMcpDoctorMode) {
  const { runProductionMcpDoctorCli } =
    await import("../dist/cli-runtime/mcpDoctor.js");
  const result = await runProductionMcpDoctorCli(args.slice(2), {
    dispatcherPath: fileURLToPath(import.meta.url),
    packageRoot,
  });
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
} else {
  const { cliConfigurationError, createCli } =
    await import("../dist/cli-runtime/cli.js");
  const { createCliResultOutput } =
    await import("../dist/cli-runtime/cliResultOutput.js");
  const {
    renderCliOutputArgumentError,
    renderEmptyFilteredCliOutput,
    validateCliOutputArguments,
  } = await import("../dist/cli-runtime/cliOutput.js");
  const outputArguments = validateCliOutputArguments(args);
  const configurationError = cliConfigurationError(process.env);
  if (configurationError !== undefined) {
    process.stderr.write(`${configurationError}\n`);
    process.exitCode = 1;
  } else if (!outputArguments.ok) {
    process.stdout.write(renderCliOutputArgumentError(outputArguments));
    process.exitCode = 1;
  } else {
    let wroteOutput = false;
    const resultOutput = createCliResultOutput(args, process.stdout);
    await createCli(process.env, resultOutput).serve(args, {
      stdout: (output) => {
        if (resultOutput?.handled) {
          if (resultOutput.failed) process.stderr.write(output);
          return;
        }
        if (output.length > 0) wroteOutput = true;
        process.stdout.write(output);
      },
    });
    if (!wroteOutput && !resultOutput?.handled)
      process.stdout.write(renderEmptyFilteredCliOutput(args) ?? "");
  }
}

async function compiledRuntimeExists(paths) {
  for (const path of paths) {
    try {
      await access(resolve(packageRoot, path));
    } catch (cause) {
      if (isMissing(cause)) return false;
      throw cause;
    }
  }
  return true;
}

function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

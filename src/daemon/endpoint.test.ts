import { describe, expect, it } from "vitest";

import { daemonEnvironmentKey, resolveDaemonEndpoint } from "./endpoint.js";

const root = "/opt/rea";

const endpoint = (
  environment: Record<string, string | undefined>,
  platform: NodeJS.Platform = "linux",
) => resolveDaemonEndpoint({ packageRoot: root, environment, platform });

describe("daemon endpoint fingerprint", () => {
  it("ignores variables that cannot change analysis results", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/a" };
    expect(
      endpoint({ ...base, TERM_SESSION_ID: "1", CLAUDECODE: "1" }).fingerprint,
    ).toBe(endpoint(base).fingerprint);
  });

  it("separates clients whose provider configuration differs", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/a" };
    const fingerprints = new Set([
      endpoint(base).fingerprint,
      endpoint({ ...base, GHIDRA_INSTALL_DIR: "/ghidra" }).fingerprint,
      endpoint({ ...base, REA_MCP_MAX_RESPONSE_BYTES: "1000" }).fingerprint,
      endpoint({ ...base, PATH: "/other/bin" }).fingerprint,
      endpoint({ ...base, JAVA_HOME: "/jdk" }).fingerprint,
      endpoint({ ...base, REA_PACKAGE_VERSION: "1.0.0" }).fingerprint,
    ]);
    expect(fingerprints.size).toBe(6);
  });

  it("does not let daemon controls split the daemon", () => {
    const base = { PATH: "/usr/bin" };
    expect(
      endpoint({
        ...base,
        REA_DAEMON: "1",
        REA_DAEMON_IDLE_MS: "5",
        REA_DAEMON_START_TIMEOUT_MS: "9",
      }).fingerprint,
    ).toBe(endpoint(base).fingerprint);
  });

  it("treats Windows variable names case-insensitively", () => {
    expect(daemonEnvironmentKey({ Path: "C:\\bin" }, "win32")).toEqual([
      ["PATH", "C:\\bin"],
    ]);
    expect(
      endpoint({ Path: "C:\\bin", LOCALAPPDATA: "C:\\L" }, "win32").fingerprint,
    ).toBe(
      endpoint({ PATH: "C:\\bin", LOCALAPPDATA: "C:\\L" }, "win32").fingerprint,
    );
  });

  it("uses a per-fingerprint named pipe on Windows and a socket elsewhere", () => {
    const windows = endpoint(
      { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
      "win32",
    );
    expect(windows.path).toBe(`\\\\.\\pipe\\rea-daemon-${windows.fingerprint}`);
    const posix = endpoint({ XDG_CACHE_HOME: "/home/a/.cache" });
    expect(posix.path).toBe(
      `/home/a/.cache/rea/daemon/${posix.fingerprint}.sock`,
    );
    // Unix domain socket paths are limited to about 104 bytes.
    expect(Buffer.byteLength(posix.path)).toBeLessThan(104);
  });
});

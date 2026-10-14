import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Content-addressed cache for the JavaScript worker's per-file results.
 *
 * Parsing and semantic projection depend only on the decoded source text, the
 * file's identity, the semantic node budget and the analyzer build, so a
 * result is keyed by exactly those inputs. Only completed computations are
 * stored; budget admission still runs on every use, and the parent validates
 * a cached result exactly as it validates a fresh one. Every failure here is
 * a cache miss: the cache can make analysis faster, never different.
 */
export interface JavaScriptAnalysisCache {
  read<Value>(kind: CacheKind, parts: unknown): Promise<Value | undefined>;
  write(kind: CacheKind, parts: unknown, value: unknown): Promise<void>;
}

type CacheKind = "static" | "semantic";

const FORMAT_VERSION = 1;
// A larger value is cheaper to recompute than to hold in the worker's heap
// twice (object plus its serialized form).
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 1024 * 1024 * 1024;

const cacheRoot = (
  environment: Readonly<Record<string, string | undefined>>,
): string => {
  const override = environment.REA_CACHE_DIR;
  if (override !== undefined && override !== "") return override;
  if (process.platform === "win32")
    return join(
      environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "rea",
      "cache",
    );
  return join(
    environment.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "rea",
    "cache",
  );
};

const maxCacheBytes = (
  environment: Readonly<Record<string, string | undefined>>,
): number => {
  const megabytes = Number(environment.REA_CACHE_MAX_MB);
  return Number.isSafeInteger(megabytes) && megabytes > 0
    ? megabytes * 1024 * 1024
    : DEFAULT_MAX_CACHE_BYTES;
};

/** The worker entry is rewritten by every build; any rebuild invalidates. */
export const javaScriptAnalyzerBuildIdentity = (
  entryPath: string,
  packageVersion: string,
): string => {
  try {
    const entry = statSync(entryPath);
    return `${packageVersion}:${process.version}:${entry.size}:${entry.mtimeMs}`;
  } catch {
    return `${packageVersion}:${process.version}:unknown`;
  }
};

/** Disabled with REA_CACHE=off; the directory is REA_CACHE_DIR or the user cache. */
export const createJavaScriptAnalysisCache = (
  environment: Readonly<Record<string, string | undefined>>,
  buildIdentity: string,
): JavaScriptAnalysisCache | undefined => {
  const setting = environment.REA_CACHE?.toLowerCase();
  if (setting === "off" || setting === "0" || setting === "false")
    return undefined;
  const directory = join(cacheRoot(environment), "javascript-analysis");
  const limit = maxCacheBytes(environment);
  let pruned = false;

  const entryKey = (kind: CacheKind, parts: unknown): string =>
    createHash("sha256")
      .update(JSON.stringify({ v: FORMAT_VERSION, kind, buildIdentity, parts }))
      .digest("hex");
  const entryPath = (key: string): string =>
    join(directory, key.slice(0, 2), `${key}.json.gz`);

  const prune = async (): Promise<void> => {
    const entries: { path: string; bytes: number; used: number }[] = [];
    for (const shard of await readdir(directory).catch(() => [])) {
      const shardPath = join(directory, shard);
      for (const name of await readdir(shardPath).catch(() => [])) {
        const path = join(shardPath, name);
        const info = await stat(path).catch(() => undefined);
        if (info?.isFile() === true)
          entries.push({ path, bytes: info.size, used: info.mtimeMs });
      }
    }
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    // Least recently used first; leave headroom so pruning stays infrequent.
    for (const entry of entries.sort((a, b) => a.used - b.used)) {
      if (total <= limit * 0.9) break;
      await rm(entry.path, { force: true }).catch(() => undefined);
      total -= entry.bytes;
    }
  };

  return {
    async read<Value>(kind: CacheKind, parts: unknown) {
      const key = entryKey(kind, parts);
      const path = entryPath(key);
      try {
        const stored: unknown = JSON.parse(
          (await gunzipAsync(await readFile(path))).toString("utf8"),
        );
        if (
          typeof stored !== "object" ||
          stored === null ||
          Reflect.get(stored, "key") !== key ||
          !Reflect.has(stored, "value")
        ) {
          await rm(path, { force: true });
          return undefined;
        }
        const now = new Date();
        await utimes(path, now, now).catch(() => undefined);
        return Reflect.get(stored, "value") as Value;
      } catch (cause: unknown) {
        // A missing entry is a plain miss; an unreadable one is discarded.
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
          await rm(path, { force: true }).catch(() => undefined);
        return undefined;
      }
    },
    async write(kind: CacheKind, parts: unknown, value: unknown) {
      try {
        const key = entryKey(kind, parts);
        const text = JSON.stringify({ key, value });
        if (text.length > MAX_ENTRY_BYTES) return;
        const path = entryPath(key);
        await mkdir(join(directory, key.slice(0, 2)), {
          recursive: true,
          mode: 0o700,
        });
        const pending = `${path}.${randomUUID()}.tmp`;
        await writeFile(pending, await gzipAsync(text, { level: 1 }), {
          mode: 0o600,
        });
        await rename(pending, path);
        if (!pruned) {
          pruned = true;
          await prune();
        }
      } catch {
        // A full disk or a racing writer only costs a later recomputation.
      }
    },
  };
};

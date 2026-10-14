import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createJavaScriptAnalysisCache } from "./JavaScriptAnalysisCache.js";

const roots: string[] = [];
const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-js-cache-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const entryFiles = async (root: string): Promise<string[]> => {
  const directory = join(root, "javascript-analysis");
  const files: string[] = [];
  for (const shard of await readdir(directory).catch(() => []))
    for (const name of await readdir(join(directory, shard)))
      files.push(join(directory, shard, name));
  return files;
};

describe("JavaScript analysis cache", () => {
  it("returns a stored value only for the same kind, inputs and build", async () => {
    const root = await temporaryRoot();
    const cache = createJavaScriptAnalysisCache({ REA_CACHE_DIR: root }, "b1");
    const parts = { text_sha256: "a".repeat(64), path: "main.js" };
    await cache?.write("static", parts, { parse_status: "parsed" });

    await expect(cache?.read("static", parts)).resolves.toEqual({
      parse_status: "parsed",
    });
    await expect(
      cache?.read("semantic", parts),
      "another kind",
    ).resolves.toBeUndefined();
    await expect(
      cache?.read("static", { ...parts, path: "other.js" }),
      "another path",
    ).resolves.toBeUndefined();
    const rebuilt = createJavaScriptAnalysisCache(
      { REA_CACHE_DIR: root },
      "b2",
    );
    await expect(
      rebuilt?.read("static", parts),
      "another build",
    ).resolves.toBeUndefined();
  });

  it("is disabled by REA_CACHE=off", () => {
    expect(
      createJavaScriptAnalysisCache({ REA_CACHE: "off" }, "b1"),
    ).toBeUndefined();
  });

  it("treats a corrupted entry as a miss and removes it", async () => {
    const root = await temporaryRoot();
    const cache = createJavaScriptAnalysisCache({ REA_CACHE_DIR: root }, "b1");
    await cache?.write("static", { k: 1 }, { value: 1 });
    const [entry] = await entryFiles(root);
    if (entry === undefined) throw new Error("expected one cache entry");
    await writeFile(entry, "not gzip");
    await expect(cache?.read("static", { k: 1 })).resolves.toBeUndefined();
    await expect(entryFiles(root)).resolves.toEqual([]);
  });

  it("evicts least recently used entries past the size limit", async () => {
    const root = await temporaryRoot();
    const payload = "x".repeat(400_000);
    // Incompressible enough to exceed 1 MiB across several entries.
    const random = (seed: number) =>
      Array.from({ length: 200_000 }, (_, index) =>
        ((index * 2654435761 + seed) >>> 0).toString(36),
      ).join("");
    const writer = createJavaScriptAnalysisCache(
      { REA_CACHE_DIR: root, REA_CACHE_MAX_MB: "1" },
      "b1",
    );
    for (let seed = 0; seed < 4; seed += 1)
      await createJavaScriptAnalysisCache(
        { REA_CACHE_DIR: root, REA_CACHE_MAX_MB: "1" },
        "b1",
      )?.write("semantic", { seed }, { payload, data: random(seed) });
    await writer?.write("semantic", { seed: "last" }, { payload: "small" });
    const files = await entryFiles(root);
    expect(files.length).toBeLessThan(5);
    await expect(writer?.read("semantic", { seed: "last" })).resolves.toEqual({
      payload: "small",
    });
  });
});

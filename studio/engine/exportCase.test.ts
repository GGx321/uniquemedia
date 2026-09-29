import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { CaseSensitivityProbe, NODE_CASE_PROBE_FS, type CaseProbeFs } from "./exportCase";
useNativeGlobals();

// Task 3a.8b.1: whether the export folder's volume folds letter case is a
// property of the VOLUME, not of the platform (APFS can be case-sensitive, an
// ext4 folder can be casefolded, a Windows folder can be case-sensitive per
// directory), so it is measured: create a probe file and ask for it back under
// a case-flipped name.

/** A tiny volume: a set of names, folding case or not, and a log of what was done to it. */
function volume(foldsCase: boolean, options: { failCreate?: boolean } = {}): CaseProbeFs & { names: Set<string>; created: string[]; removed: string[] } {
  const key = (path: string) => (foldsCase ? path.toLowerCase() : path);
  const names = new Set<string>();
  const created: string[] = [];
  const removed: string[] = [];
  return {
    names,
    created,
    removed,
    createExclusive: async (path) => {
      if (options.failCreate === true) throw Object.assign(new Error("read-only"), { code: "EROFS" });
      if (names.has(key(path))) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      names.add(key(path));
      created.push(path);
    },
    exists: async (path) => names.has(key(path)),
    remove: async (path) => {
      names.delete(key(path));
      removed.push(path);
    },
    isDirectory: async () => true,
  };
}

const ids = (): (() => string) => {
  let n = 0;
  return () => `probe${String(++n).padStart(4, "0")}abcd`;
};

describe("CaseSensitivityProbe", () => {
  test("says a volume that finds the case-flipped name is case-insensitive", async () => {
    const probe = new CaseSensitivityProbe(volume(true), ids());
    expect(await probe.isCaseInsensitive("/export")).toBe(true);
  });

  test("says a volume that does not find the case-flipped name is case-sensitive", async () => {
    const probe = new CaseSensitivityProbe(volume(false), ids());
    expect(await probe.isCaseInsensitive("/export")).toBe(false);
  });

  test("probes with a file of the sweep's own shape, and removes it", async () => {
    const fs = volume(false);
    await new CaseSensitivityProbe(fs, ids()).isCaseInsensitive("/export");
    expect(fs.created).toHaveLength(1);
    // The probe resolves the root as the platform does (`D:\export` on Windows), so the folder is compared as a path, not as text.
    expect(dirname(fs.created[0] ?? "")).toBe(resolve("/export"));
    expect(basename(fs.created[0] ?? "")).toMatch(/^\.studio-probe-case-[a-z0-9]+$/);
    expect(fs.removed).toEqual(fs.created);
    expect(fs.names.size).toBe(0);
  });

  test("the probe name has letters in it, or flipping its case would change nothing", async () => {
    const fs = volume(false);
    await new CaseSensitivityProbe(fs, () => "12345678").isCaseInsensitive("/export");
    expect(fs.created[0]).toMatch(/[a-z]/);
  });

  test("asks the disk once per root: a second question is answered from the cache", async () => {
    const fs = volume(true);
    const probe = new CaseSensitivityProbe(fs, ids());
    await probe.isCaseInsensitive("/export");
    await probe.isCaseInsensitive("/export");
    expect(fs.created).toHaveLength(1);
  });

  test("two questions at once share one probe", async () => {
    const fs = volume(true);
    const probe = new CaseSensitivityProbe(fs, ids());
    const [a, b] = await Promise.all([probe.isCaseInsensitive("/export"), probe.isCaseInsensitive("/export")]);
    expect([a, b]).toEqual([true, true]);
    expect(fs.created).toHaveLength(1);
  });

  test("probes each root on its own: another folder can be on another volume", async () => {
    const fs = volume(true);
    const probe = new CaseSensitivityProbe(fs, ids());
    await probe.isCaseInsensitive("/export-a");
    await probe.isCaseInsensitive("/export-b");
    expect(fs.created).toHaveLength(2);
  });

  test("a folder that does not exist yet is NOT judged by its parent (another volume): the cautious answer, no probe file anywhere, and not remembered", async () => {
    let exists = false;
    const fs = { ...volume(false), isDirectory: async () => exists };
    const probe = new CaseSensitivityProbe(fs, ids());
    expect(await probe.isCaseInsensitive("/parent/not/yet")).toBe(true);
    expect(fs.created).toEqual([]);
    exists = true;
    expect(await probe.isCaseInsensitive("/parent/not/yet")).toBe(false); // asked again once the root is there
    expect(fs.created).toHaveLength(1);
  });

  test("when the probe file cannot be created it answers case-insensitive, the cautious guess, and does not cache it", async () => {
    let failing = true;
    const inner = volume(false);
    const fs: CaseProbeFs = { ...inner, createExclusive: (path) => (failing ? Promise.reject(Object.assign(new Error("read-only"), { code: "EROFS" })) : inner.createExclusive(path)) };
    const probe = new CaseSensitivityProbe(fs, ids());
    expect(await probe.isCaseInsensitive("/export")).toBe(true);
    failing = false;
    expect(await probe.isCaseInsensitive("/export")).toBe(false);
  });

  test("a probe file that cannot be removed still gives the answer, and the leftover is a 0-byte .studio-probe-* the open sweep collects", async () => {
    const fs: CaseProbeFs = { ...volume(false), remove: () => Promise.reject(Object.assign(new Error("busy"), { code: "EBUSY" })) };
    expect(await new CaseSensitivityProbe(fs, ids()).isCaseInsensitive("/export")).toBe(false);
  });
});

describe("the real disk", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("agrees with what this volume does with a case-flipped name, and leaves the folder empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-case-"));
    dirs.push(dir);
    writeFileSync(join(dir, "oracle-file"), "");
    const oracle = readdirSync(dir).includes("oracle-file") && (await NODE_CASE_PROBE_FS.exists(join(dir, "ORACLE-FILE")));
    rmSync(join(dir, "oracle-file"));
    expect(await new CaseSensitivityProbe(NODE_CASE_PROBE_FS).isCaseInsensitive(dir)).toBe(oracle);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("says a default NTFS folder is case-insensitive (Windows only)", async () => {
    if (process.platform !== "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "studio-case-"));
    dirs.push(dir);
    expect(await new CaseSensitivityProbe(NODE_CASE_PROBE_FS).isCaseInsensitive(dir)).toBe(true);
  });

  test("a folder that is not there leaves its parent untouched and answers cautiously", async () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-case-"));
    dirs.push(dir);
    expect(await new CaseSensitivityProbe(NODE_CASE_PROBE_FS).isCaseInsensitive(join(dir, "not", "yet"))).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});

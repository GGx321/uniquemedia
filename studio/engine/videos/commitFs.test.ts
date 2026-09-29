import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { NODE_COMMIT_FS } from "./commitFs";
useNativeGlobals();

// The port the commit and its recovery use: the parts a fake could get wrong.

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-commitfs-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("createExclusive", () => {
  test("creates an empty file and reports the inode it created, from the open handle", async () => {
    const identity = await NODE_COMMIT_FS.createExclusive(join(dir, "a"));
    const info = statSync(join(dir, "a"));
    expect(identity).toEqual({ dev: info.dev, ino: info.ino });
    expect(info.size).toBe(0);
  });

  test("never replaces anything: EEXIST for a file, a folder or a dangling symlink, which is left as it was", async () => {
    await writeFile(join(dir, "file"), "mine");
    await symlink(join(dir, "nowhere"), join(dir, "dangling"));
    for (const name of ["file", "dangling"]) await expect(NODE_COMMIT_FS.createExclusive(join(dir, name))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(dir, "file"), "utf8")).toBe("mine");
    expect(() => statSync(join(dir, "nowhere"))).toThrow();
  });
});

describe("link", () => {
  test("gives a second name to a file, and refuses (EEXIST) to replace an existing one", async () => {
    await writeFile(join(dir, "intent"), "record");
    await writeFile(join(dir, "taken"), "other");
    await NODE_COMMIT_FS.link(join(dir, "intent"), join(dir, "record"));
    expect(await readFile(join(dir, "record"), "utf8")).toBe("record");
    await expect(NODE_COMMIT_FS.link(join(dir, "intent"), join(dir, "taken"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(dir, "taken"), "utf8")).toBe("other");
  });
});

describe("readdir", () => {
  test("reports a symlink as a symlink, never as the folder or file it points at", async () => {
    await writeFile(join(dir, "f"), "x");
    await symlink(dir, join(dir, "link"));
    const entries = await NODE_COMMIT_FS.readdir(dir);
    expect(entries.find((e) => e.name === "link")).toMatchObject({ isSymbolicLink: true, isDirectory: false, isFile: false });
    expect(entries.find((e) => e.name === "f")).toMatchObject({ isFile: true, isSymbolicLink: false });
  });
});

describe("the port has no copy", () => {
  test("temp and placeholder share a folder, so there is nothing to copy across", () => {
    expect(Object.keys(NODE_COMMIT_FS)).not.toContain("copyOver");
  });
});

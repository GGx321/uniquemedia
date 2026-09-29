import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { hasErrorCode } from "../library/durableFs";
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
    // bigint: an NTFS file index is above 2^53, and a number stat rounds it to a neighbour's value.
    const info = statSync(join(dir, "a"), { bigint: true });
    expect(identity).toEqual({ dev: String(info.dev), ino: String(info.ino) });
    expect(info.size).toBe(0n);
  });

  test("never replaces anything: EEXIST for a file or a folder, which are left as they were", async () => {
    await writeFile(join(dir, "file"), "mine");
    await mkdir(join(dir, "folder"));
    for (const name of ["file", "folder"]) await expect(NODE_COMMIT_FS.createExclusive(join(dir, name))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(dir, "file"), "utf8")).toBe("mine");
    expect(statSync(join(dir, "folder")).isDirectory()).toBe(true);
  });

  test("never writes through a dangling symlink: EEXIST, and nothing is created at its target", async () => {
    try {
      await symlink(join(dir, "nowhere"), join(dir, "dangling"));
    } catch (error) {
      // Windows makes a symlink only for a user with the privilege (or in developer mode); without it there is nothing to play.
      if (process.platform === "win32" && hasErrorCode(error, "EPERM")) return;
      throw error;
    }
    await expect(NODE_COMMIT_FS.createExclusive(join(dir, "dangling"))).rejects.toMatchObject({ code: "EEXIST" });
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

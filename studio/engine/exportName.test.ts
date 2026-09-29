import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { isSafeName, RelativePath, VideoKindToken } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
import {
  claimExportName,
  ExportFolderError,
  exportFileName,
  formatExportDate,
  kindToken,
  NODE_EXPORT_FOLDER_FS,
  NODE_EXPORT_NAME_FS,
  prepareExportFolder,
  safeName,
  suffixedFolderName,
  type ExportFolderFs,
  type ExportNameFs,
  type PreparedFolder,
} from "./exportName";
useNativeGlobals();

const AVATAR = "avatar-0001";

/** A small seeded generator (mulberry32): the property tests are random but reproducible. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTILE_PIECES = [
  "Con", "CON", "nul.txt", "aux", "PRN", "com1", "LPT9", "COM0", "Мия", "Ольга", "Ёлка", "Съезд", "😀", "👩‍👩‍👧", "é", "ñ", "ß", "Ａｂｃ", "\u0000", "\n", "\t",
  " ", "  ", ".", "..", "...", "/", "\\", ":", "*", "?", "\"", "<", ">", "|", "~", "-", "_", "--", "__", "‮", "‍", "a", "Z", "9", "x".repeat(200),
];

function hostileName(random: () => number): string {
  const pieces = 1 + Math.floor(random() * 6);
  let out = "";
  for (let i = 0; i < pieces; i++) out += HOSTILE_PIECES[Math.floor(random() * HOSTILE_PIECES.length)];
  return out;
}

describe("safeName", () => {
  test("keeps a plain ASCII name as it is", () => {
    expect(safeName("Mia", AVATAR)).toBe("Mia");
  });

  test("keeps underscores and hyphens", () => {
    expect(safeName("anna_maria-2", AVATAR)).toBe("anna_maria-2");
  });

  test("turns spaces and punctuation into one underscore", () => {
    expect(safeName("Mia  &  Co.", AVATAR)).toBe("Mia_Co");
  });

  test("drops the accents of a Latin name instead of the whole letter", () => {
    expect(safeName("Zoë Ñandú", AVATAR)).toBe("Zoe_Nandu");
  });

  test.each([
    ["Мия", "Miya"],
    ["Ольга", "Olga"],
    ["Ёлка", "Yolka"],
    ["Мия 2", "Miya_2"],
    ["Щука", "Shchuka"],
    ["Съезд", "Sezd"],
    ["Соль", "Sol"],
    ["Жанна", "Zhanna"],
    ["Юля", "Yulya"],
    ["Анна-Мария", "Anna-Mariya"],
    ["Їжак", "Yizhak"],
    ["Цветы", "Tsvety"],
    ["Хлоя", "Khloya"],
    ["Mia Мия", "Mia_Miya"],
  ])("transliterates the Cyrillic name %s to %s", (name, expected) => {
    expect(safeName(name, AVATAR)).toBe(expected);
  });

  test.each([
    ["a decomposed Ё (Е and a diaeresis)", "Ёлка", "Yolka"],
    ["a decomposed Й (И and a breve)", "Йога", "Yoga"],
    ["a decomposed ё in lower case", "ёлка", "yolka"],
    ["a decomposed Ї (І and a diaeresis)", "Їжак", "Yizhak"],
  ])("transliterates %s the same as the composed letter", (_label, name, expected) => {
    expect(safeName(name, AVATAR)).toBe(expected);
  });

  test("a precomposed Cyrillic letter outside the table keeps its base letter (Ў becomes U)", () => {
    expect(safeName("Ўла", AVATAR)).toBe("Ula");
    expect(safeName("Ўла".normalize("NFD"), AVATAR)).toBe("Ula");
  });

  test.each([
    ["Ъя", "Ya"],
    ["Ьва", "Va"],
    ["ъя", "ya"],
    ["ЪЯ", "YA"],
  ])("capitalises the first letter that is actually written: %s → %s", (name, expected) => {
    // A name must keep two letters to be used, so add a tail that changes nothing about the head.
    expect(safeName(`${name}xy`, AVATAR).startsWith(expected)).toBe(true);
  });

  test("keeps an all-capitals Cyrillic name in capitals", () => {
    expect(safeName("МИЯ", AVATAR)).toBe("MIYA");
    expect(safeName("ЮЛЯ", AVATAR)).toBe("YULYA");
  });

  test("gives the same result for the same name every time", () => {
    expect(safeName("Мия", "avatar-0002")).toBe(safeName("Мия", "avatar-0009"));
  });

  test.each(["A", "2", "A2", "-a-", "ь", "_1_"])("falls back to the avatar id when %p has fewer than two letters", (name) => {
    expect(safeName(name, AVATAR)).toBe(AVATAR);
  });

  test("keeps a name of exactly two letters", () => {
    expect(safeName("Ab", AVATAR)).toBe("Ab");
  });

  test("falls back to the avatar id for an emoji-only name", () => {
    expect(safeName("😀😀", AVATAR)).toBe(AVATAR);
  });

  test("falls back to the avatar id for an empty name", () => {
    expect(safeName("", AVATAR)).toBe(AVATAR);
  });

  test("falls back to the avatar id for a name of only separators", () => {
    expect(safeName("...  --  __", AVATAR)).toBe(AVATAR);
  });

  test("falls back to the avatar id for a name in a script with no table (Chinese)", () => {
    expect(safeName("小明", AVATAR)).toBe(AVATAR);
  });

  test.each(["Con", "CON", "prn", "Aux", "NUL", "com1", "COM9", "lpt1", "LPT9", "com0"])("does not use the Windows device name %s as a folder", (name) => {
    expect(safeName(name, AVATAR)).toBe(AVATAR);
  });

  test("a Cyrillic word that reads as a device name once transliterated falls back too", () => {
    expect(safeName("Прн", AVATAR)).toBe(AVATAR);
    expect(safeName("Нул", AVATAR)).toBe(AVATAR);
  });

  test("turns nul.txt into a name that is not a device (the dot becomes an underscore)", () => {
    expect(safeName("nul.txt", AVATAR)).toBe("nul_txt");
  });

  test("has no trailing dot or space, which Windows would strip", () => {
    expect(safeName("Mia. ", AVATAR)).toBe("Mia");
  });

  test("keeps at most 64 characters of a 200-character name", () => {
    expect(safeName("a".repeat(200), AVATAR)).toBe("a".repeat(64));
  });

  test("does not end on a separator after the 64-character cut", () => {
    expect(safeName(`${"a".repeat(63)} b`, AVATAR)).toBe("a".repeat(63));
  });

  test("a device name followed by more words is not a device name", () => {
    expect(safeName("con    xyz", AVATAR)).toBe("con_xyz");
    expect(isSafeName(safeName("con", AVATAR))).toBe(true);
  });

  test("does not read an avatar name that looks like a path as one", () => {
    expect(safeName("../../etc/passwd", AVATAR)).toBe("etc_passwd");
  });

  test("two case variants stay distinct strings (the folder merge on a case-insensitive disk is handled where the folder is opened)", () => {
    expect(safeName("MIA", AVATAR)).not.toBe(safeName("mia", AVATAR));
  });

  test("property: over 5000 hostile names the result is a SafeName and the full path always satisfies RelativePath", () => {
    const random = prng(20260929);
    for (let i = 0; i < 5000; i++) {
      const name = safeName(hostileName(random), AVATAR);
      expect(isSafeName(name)).toBe(true);
      const relPath = `${name}/${exportFileName("2026-09-29", "collage3", 1 + Math.floor(random() * 999))}`;
      expect(RelativePath.safeParse(relPath).success).toBe(true);
    }
  });

  test("property: a name that is already valid and has two letters comes back unchanged", () => {
    const random = prng(7);
    const alphabet = "abcXYZ019_-";
    for (let i = 0; i < 500; i++) {
      let raw = "";
      const length = 1 + Math.floor(random() * 30);
      for (let j = 0; j < length; j++) raw += alphabet[Math.floor(random() * alphabet.length)];
      const core = raw.replace(/^[_-]+|[_-]+$/g, "");
      if (!isSafeName(core) || (core.match(/[A-Za-z]/g) ?? []).length < 2) continue;
      expect(safeName(core, AVATAR)).toBe(core);
    }
  });

  test("an avatar id that is itself hostile still gives a valid folder", () => {
    expect(isSafeName(safeName("😀", "CON"))).toBe(true);
    expect(isSafeName(safeName("😀", "😀"))).toBe(true);
  });
});

describe("suffixedFolderName", () => {
  test("adds the first eight characters of the avatar id", () => {
    expect(suffixedFolderName("Mia", "avatar-0001")).toBe("Mia_avatar-0");
  });

  test("stays within 64 characters for a 64-character name", () => {
    const name = suffixedFolderName("a".repeat(64), "avatar-0001");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(isSafeName(name)).toBe(true);
  });

  test("is a SafeName even when the id is hostile", () => {
    expect(isSafeName(suffixedFolderName("Mia", "😀"))).toBe(true);
    expect(isSafeName(suffixedFolderName("CON", "CON"))).toBe(true);
  });
});

describe("kindToken", () => {
  test.each(["photo", "collage3", "mix"])("keeps %s", (kind) => {
    expect(kindToken(kind)).toBe(kind);
  });

  test("lowercases and drops what is not a letter or a digit", () => {
    expect(kindToken("Collage 3")).toBe("collage3");
  });

  test("drops leading digits, because a token starts with a letter", () => {
    expect(kindToken("3d-photo")).toBe("dphoto");
  });

  test("keeps at most 16 characters", () => {
    expect(kindToken("a".repeat(40))).toBe("a".repeat(16));
  });

  test.each(["", "😀", "123", "---"])("falls back to video for %p", (raw) => {
    expect(kindToken(raw)).toBe("video");
  });

  test("property: the token always satisfies VideoKindToken", () => {
    const random = prng(11);
    for (let i = 0; i < 2000; i++) expect(VideoKindToken.safeParse(kindToken(hostileName(random))).success).toBe(true);
  });
});

describe("exportFileName and formatExportDate", () => {
  test("pads the counter to three digits", () => {
    expect(exportFileName("2026-09-29", "photo", 7)).toBe("2026-09-29_photo_007.mp4");
  });

  test("lets the counter grow past 999", () => {
    expect(exportFileName("2026-09-29", "photo", 1000)).toBe("2026-09-29_photo_1000.mp4");
  });

  test("formats the local date with zero padding", () => {
    expect(formatExportDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

// ---------- opening the avatar's folder (B1) ----------

/**
 * The path spellings the folder rules must handle. The code takes the flavour as a dependency, so
 * Windows' `\`, drive letters and UNC run here on any OS, not only on a Windows runner.
 */
const FLAVOURS = [
  { name: "posix", api: posix, top: "/" },
  { name: "win32", api: win32, top: "C:\\" },
] as const;

interface FakeEntry {
  kind: "dir" | "link" | "file";
  /** Where a link or a directory really is, as `realpath` says. */
  real?: string;
}

/** A tiny in-memory disk for the folder rules: which path is what, and where `realpath` leads. Its paths are spelled in `api`'s flavour. */
function fakeFolderFs(api: typeof posix, entries: Record<string, FakeEntry>): ExportFolderFs & { made: string[] } {
  const table = new Map(Object.entries(entries));
  const made: string[] = [];
  return {
    made,
    async mkdir(path) {
      if (table.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      const parent = api.dirname(path);
      const isDriveRoot = api.dirname(parent) === parent;
      if (!isDriveRoot && !table.has(parent)) throw Object.assign(new Error("no parent"), { code: "ENOENT" });
      table.set(path, { kind: "dir" });
      made.push(path);
    },
    async lstat(path) {
      const entry = table.get(path);
      if (entry === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return { isDirectory: () => entry.kind === "dir", isSymbolicLink: () => entry.kind === "link" };
    },
    async realpath(path) {
      const entry = table.get(path);
      if (entry === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return entry.real ?? path;
    },
  };
}

/** The folder's two public fields, for comparing with a plain object. */
function plain(folder: PreparedFolder): { name: string; path: string } {
  return { name: folder.name, path: folder.path };
}

for (const { name: flavour, api, top } of FLAVOURS) {
  describe(`prepareExportFolder with a fake disk (${flavour} paths)`, () => {
    const at = (...parts: string[]) => api.join(top, ...parts);
    const root = at("export");
    const base = { root, safeName: "Mia", avatarId: AVATAR, caseInsensitive: false, api };
    const dir = { kind: "dir" } as const;

    test("creates a missing folder and returns its name and path", async () => {
      const fs = fakeFolderFs(api, { [root]: dir });
      expect(plain(await prepareExportFolder({ fs, ...base }))).toEqual({ name: "Mia", path: at("export", "Mia") });
      expect(fs.made).toEqual([at("export", "Mia")]);
    });

    test("reuses a folder that is already there", async () => {
      const fs = fakeFolderFs(api, { [root]: dir, [at("export", "Mia")]: dir });
      expect(plain(await prepareExportFolder({ fs, ...base }))).toEqual({ name: "Mia", path: at("export", "Mia") });
      expect(fs.made).toEqual([]);
    });

    test("a symlink in the folder's place is not written through: the suffixed folder is used", async () => {
      const fs = fakeFolderFs(api, { [root]: dir, [at("export", "Mia")]: { kind: "link", real: at("elsewhere") }, [at("elsewhere")]: dir });
      expect(plain(await prepareExportFolder({ fs, ...base }))).toEqual({ name: "Mia_avatar-0", path: at("export", "Mia_avatar-0") });
    });

    test("a junction reads as a symlink and is refused the same way", async () => {
      const fs = fakeFolderFs(api, { [root]: dir, [at("export", "Mia")]: { kind: "link", real: at("library") } });
      expect((await prepareExportFolder({ fs, ...base })).name).toBe("Mia_avatar-0");
    });

    test("a regular file in the folder's place gives the suffixed folder, not a raw EEXIST", async () => {
      const fs = fakeFolderFs(api, { [root]: dir, [at("export", "Mia")]: { kind: "file" } });
      expect((await prepareExportFolder({ fs, ...base })).name).toBe("Mia_avatar-0");
    });

    test("a directory whose real path is elsewhere (a mount or a bind) is refused", async () => {
      const fs = fakeFolderFs(api, { [root]: dir, [at("export", "Mia")]: { kind: "dir", real: at("other", "place", "Mia") } });
      expect((await prepareExportFolder({ fs, ...base })).name).toBe("Mia_avatar-0");
    });

    test("when the suffixed folder is also a link, it refuses with not-writable", async () => {
      const fs = fakeFolderFs(api, {
        [root]: dir,
        [at("export", "Mia")]: { kind: "link", real: at("x") },
        [at("export", "Mia_avatar-0")]: { kind: "link", real: at("y") },
      });
      const error = await prepareExportFolder({ fs, ...base }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExportFolderError);
      expect(error instanceof ExportFolderError ? error.reason : null).toBe("not-writable");
    });

    test("a vanished export root refuses with missing, and nothing is created", async () => {
      const fs = fakeFolderFs(api, {});
      const error = await prepareExportFolder({ fs, ...base }).catch((e: unknown) => e);
      expect(error instanceof ExportFolderError ? error.reason : null).toBe("missing");
      expect(fs.made).toEqual([]);
    });

    test("returns the name the disk stores, not the one asked for", async () => {
      const fs = fakeFolderFs(api, { [root]: dir, [at("export", "Mia")]: { kind: "dir", real: at("export", "mia") } });
      expect(plain(await prepareExportFolder({ fs, ...base, caseInsensitive: true }))).toEqual({ name: "mia", path: at("export", "mia") });
    });

    test("an on-disk name that is not a SafeName is not used", async () => {
      const fs = fakeFolderFs(api, { [root]: dir, [at("export", "Mia")]: { kind: "dir", real: at("export", "M ia") } });
      expect((await prepareExportFolder({ fs, ...base, caseInsensitive: true })).name).toBe("Mia_avatar-0");
    });

    test("the parent of the real folder may differ from the root in letter case on a case-insensitive volume only", async () => {
      const entries = { [root]: { kind: "dir" as const, real: at("EXPORT") }, [at("export", "Mia")]: { kind: "dir" as const, real: at("export", "Mia") } };
      expect((await prepareExportFolder({ fs: fakeFolderFs(api, entries), ...base, caseInsensitive: true })).name).toBe("Mia");
      await expect(prepareExportFolder({ fs: fakeFolderFs(api, entries), ...base, caseInsensitive: false })).rejects.toBeInstanceOf(ExportFolderError);
    });

    test("an unexpected error is not swallowed", async () => {
      const fs: ExportFolderFs = {
        mkdir: async () => Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })),
        lstat: async () => Promise.reject(new Error("unused")),
        realpath: async () => Promise.reject(new Error("unused")),
      };
      const error = await prepareExportFolder({ fs, ...base }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExportFolderError);
    });

    test("refuses an unsafe folder name before touching the disk", async () => {
      const fs = fakeFolderFs(api, { [root]: dir });
      await expect(prepareExportFolder({ fs, ...base, safeName: "CON" })).rejects.toThrow();
      await expect(prepareExportFolder({ fs, ...base, safeName: "../x" })).rejects.toThrow();
      expect(fs.made).toEqual([]);
    });
  });
}

describe("prepareExportFolder on POSIX keeps a backslash as a name character", () => {
  test("a root whose name ends in a backslash is not the folder without it", async () => {
    // "/exp\" and "/exp" are two different directories on POSIX; a real path under the second is not inside the first.
    const fs = fakeFolderFs(posix, {
      "/exp\\": { kind: "dir", real: "/exp\\" },
      "/exp\\/Mia": { kind: "dir", real: "/exp/Mia" },
    });
    const folder = await prepareExportFolder({ fs, root: "/exp\\", safeName: "Mia", avatarId: AVATAR, caseInsensitive: false, api: posix });
    expect(folder.name).toBe("Mia_avatar-0");
  });
});

describe("PreparedFolder.fileIn", () => {
  async function folderIn(api: typeof posix, top: string) {
    const root = api.join(top, "export");
    const fs = fakeFolderFs(api, { [root]: { kind: "dir" } });
    return prepareExportFolder({ fs, root, safeName: "Mia", avatarId: AVATAR, caseInsensitive: false, api });
  }

  test("joins a plain file name onto the folder's path", async () => {
    expect((await folderIn(win32, "C:\\")).fileIn("a.mp4")).toBe("C:\\export\\Mia\\a.mp4");
    expect((await folderIn(posix, "/")).fileIn("a.mp4")).toBe("/export/Mia/a.mp4");
  });

  test.each(["", ".", "..", "a/b", "../x", "/abs"])("refuses %p on both flavours", async (name) => {
    expect((await folderIn(posix, "/")).fileIn.bind(await folderIn(posix, "/"), name)).toThrow();
    expect((await folderIn(win32, "C:\\")).fileIn.bind(await folderIn(win32, "C:\\"), name)).toThrow();
  });

  test.each(["a\\b", "..\\x", "C:x", "\\\\srv\\share"])("refuses %p on Windows, where the backslash and the drive separate paths", async (name) => {
    const folder = await folderIn(win32, "C:\\");
    expect(() => folder.fileIn(name)).toThrow();
  });

  test("accepts a backslash in a name on POSIX, where it is an ordinary character", async () => {
    expect((await folderIn(posix, "/")).fileIn("a\\b")).toBe("/export/Mia/a\\b");
  });

  test.each([
    "a.",
    "a ",
    "a:b",
    "a\u0001b",
    "a\u001fb",
    'a"b',
    "a<b",
    "a>b",
    "a|b",
    "a?b",
    "a*b",
    "CON",
    "con.mp4",
    "Nul.tar.gz",
    "COM1",
    "lpt9.txt",
    "aux .mp4",
  ])("refuses %p on Windows, where Windows would rename it, read it as a stream or open a device", async (name) => {
    const folder = await folderIn(win32, "C:\\");
    expect(() => folder.fileIn(name)).toThrow();
  });

  test.each(["2026-09-29_photo_001.mp4", "a b.mp4", "console.mp4", "com10.mp4", "a.b.mp4"])("accepts %p on Windows", async (name) => {
    const folder = await folderIn(win32, "C:\\");
    expect(folder.fileIn(name)).toBe(`C:\\export\\Mia\\${name}`);
  });

  test.each(["a.", "a ", "a:b", "CON", "con.mp4", "a\u0001b"])("keeps %p legal on POSIX", async (name) => {
    const folder = await folderIn(posix, "/");
    expect(folder.fileIn(name)).toBe(`/export/Mia/${name}`);
  });
});

describe("prepareExportFolder with Windows path spellings", () => {
  const dir = { kind: "dir" } as const;
  const base = { safeName: "Mia", avatarId: AVATAR, caseInsensitive: true, api: win32 };

  test("a drive letter and a folder that differ from the root only in case are contained (C:\\a against c:\\A\\b)", async () => {
    const fs = fakeFolderFs(win32, {
      "C:\\a": { kind: "dir", real: "c:\\A" },
      "C:\\a\\Mia": { kind: "dir", real: "C:\\a\\Mia" },
    });
    expect(plain(await prepareExportFolder({ fs, ...base, root: "C:\\a" }))).toEqual({ name: "Mia", path: "C:\\a\\Mia" });
  });

  test("the same spelling difference is not containment when the volume is case-sensitive", async () => {
    const fs = fakeFolderFs(win32, {
      "C:\\a": { kind: "dir", real: "c:\\A" },
      "C:\\a\\Mia": { kind: "dir", real: "C:\\a\\Mia" },
    });
    await expect(prepareExportFolder({ fs, ...base, root: "C:\\a", caseInsensitive: false })).rejects.toBeInstanceOf(ExportFolderError);
  });

  test("a real path with the \\\\?\\ prefix is the same place as the root without it", async () => {
    const fs = fakeFolderFs(win32, {
      "C:\\export": { kind: "dir", real: "C:\\export" },
      "C:\\export\\Mia": { kind: "dir", real: "\\\\?\\C:\\export\\Mia" },
    });
    expect(plain(await prepareExportFolder({ fs, ...base, root: "C:\\export" }))).toEqual({ name: "Mia", path: "C:\\export\\Mia" });
  });

  test("a root real path with the \\\\?\\ prefix is the same place as a folder without it", async () => {
    const fs = fakeFolderFs(win32, {
      "C:\\export": { kind: "dir", real: "\\\\?\\C:\\export" },
      "C:\\export\\Mia": { kind: "dir", real: "C:\\export\\Mia" },
    });
    expect((await prepareExportFolder({ fs, ...base, root: "C:\\export" })).name).toBe("Mia");
  });

  test("a UNC share is contained whether its real path is spelled \\\\srv\\share or \\\\?\\UNC\\srv\\share", async () => {
    const fs = fakeFolderFs(win32, {
      "\\\\srv\\share\\export": { kind: "dir", real: "\\\\srv\\share\\export" },
      "\\\\srv\\share\\export\\Mia": { kind: "dir", real: "\\\\?\\UNC\\srv\\share\\export\\Mia" },
    });
    expect(plain(await prepareExportFolder({ fs, ...base, root: "\\\\srv\\share\\export" }))).toEqual({ name: "Mia", path: "\\\\srv\\share\\export\\Mia" });
  });

  test("a folder that really lives on another drive is refused", async () => {
    const fs = fakeFolderFs(win32, {
      "C:\\export": dir,
      "C:\\export\\Mia": { kind: "dir", real: "D:\\export\\Mia" },
    });
    expect((await prepareExportFolder({ fs, ...base, root: "C:\\export" })).name).toBe("Mia_avatar-0");
  });

  test("a root written with a trailing separator is still the parent of its folders", async () => {
    const fs = fakeFolderFs(win32, {
      "C:\\export\\": { kind: "dir", real: "C:\\export\\" },
      "C:\\export\\Mia": { kind: "dir", real: "C:\\export\\Mia" },
    });
    expect((await prepareExportFolder({ fs, ...base, root: "C:\\export\\" })).name).toBe("Mia");
  });
});

describe("prepareExportFolder on the real disk", () => {
  async function withDirs(run: (dirs: { root: string; outside: string; library: string }) => Promise<void>): Promise<void> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "studio-export-folder-")));
    const dirs = { root: join(dir, "export"), outside: join(dir, "outside"), library: join(dir, "library") };
    await mkdir(dirs.root);
    await mkdir(dirs.outside);
    await mkdir(dirs.library);
    try {
      await run(dirs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const base = { fs: NODE_EXPORT_FOLDER_FS, safeName: "Mia", avatarId: AVATAR, caseInsensitive: process.platform !== "linux" };

  test("creates the folder under the root", async () => {
    await withDirs(async ({ root }) => {
      const folder = await prepareExportFolder({ ...base, root });
      expect((await stat(folder.path)).isDirectory()).toBe(true);
      expect(folder.name).toBe("Mia");
    });
  });

  test("a planted symlink to another folder is never written through", async () => {
    await withDirs(async ({ root, outside }) => {
      await symlink(outside, join(root, "Mia"));
      const folder = await prepareExportFolder({ ...base, root });
      expect(folder.name).toBe("Mia_avatar-0");
      expect(folder.path).toBe(join(root, "Mia_avatar-0"));
      expect(await readdir(outside)).toEqual([]);
    });
  });

  test("a planted symlink into the library never lands a file in the library", async () => {
    await withDirs(async ({ root, library }) => {
      await symlink(library, join(root, "Zoe"));
      const folder = await prepareExportFolder({ ...base, root, safeName: "Zoe" });
      const claim = await claimExportName({ fs: NODE_EXPORT_NAME_FS, folder, date: "2026-09-29", kind: "photo" });
      expect(claim.absPath.startsWith(join(root, "Zoe_avatar-0"))).toBe(true);
      expect(await readdir(library)).toEqual([]);
    });
  });

  test("a regular file at the folder's name gives the suffixed folder", async () => {
    await withDirs(async ({ root }) => {
      await writeFile(join(root, "Mia"), "a file");
      const folder = await prepareExportFolder({ ...base, root });
      expect(folder.name).toBe("Mia_avatar-0");
      expect(await readFile(join(root, "Mia"), "utf8")).toBe("a file");
    });
  });

  test("a vanished root is refused as missing and is not recreated with its parents", async () => {
    await withDirs(async ({ root }) => {
      await rm(root, { recursive: true });
      const error = await prepareExportFolder({ ...base, root }).catch((e: unknown) => e);
      expect(error instanceof ExportFolderError ? error.reason : null).toBe("missing");
      expect(await stat(root).catch(() => null)).toBeNull();
    });
  });

  test("a root that is itself a symlink to a real folder still works", async () => {
    await withDirs(async ({ root, outside }) => {
      const via = join(outside, "..", "via-link");
      await symlink(root, via);
      const folder = await prepareExportFolder({ ...base, root: via });
      expect(folder.name).toBe("Mia");
      expect(await readdir(root)).toEqual(["Mia"]);
    });
  });

  test("case variants of one name end in the folder the disk actually has", async () => {
    await withDirs(async ({ root }) => {
      const first = await prepareExportFolder({ ...base, root, safeName: "Mia" });
      const second = await prepareExportFolder({ ...base, root, safeName: "mia" });
      const onDisk = await readdir(root);
      expect(onDisk).toContain(first.name);
      expect(onDisk).toContain(second.name);
      if (onDisk.length === 1) expect(second.name).toBe(first.name);
    });
  });
});

// ---------- claiming the file name ----------

for (const { name: flavour, api, top } of FLAVOURS) {
  describe(`claimExportName with a fake disk (${flavour} paths)`, () => {
    const at = (...parts: string[]) => api.join(top, ...parts);
    /** An in-memory folder: `createExclusive` fails with EEXIST for a taken path, comparing case-insensitively when asked. */
    function fakeFs(taken: string[], opts: { caseInsensitive?: boolean } = {}): ExportNameFs & { made: string[] } {
      const norm = (p: string) => (opts.caseInsensitive === true ? p.toLowerCase() : p);
      const files = new Set(taken.map(norm));
      const made: string[] = [];
      return {
        made,
        async createExclusive(path) {
          if (files.has(norm(path))) throw Object.assign(new Error("exists"), { code: "EEXIST" });
          files.add(norm(path));
          made.push(path);
        },
      };
    }

    const inMia = (file: string) => at("export", "Mia", file);

    // A folder can only come from prepareExportFolder: here, over the fake disk.
    let base: { folder: PreparedFolder; date: string; kind: string };
    beforeAll(async () => {
      const folder = await prepareExportFolder({
        fs: fakeFolderFs(api, { [at("export")]: { kind: "dir" } }),
        root: at("export"),
        safeName: "Mia",
        avatarId: AVATAR,
        caseInsensitive: false,
        api,
      });
      base = { folder, date: "2026-09-29", kind: "photo" };
    });

    test("claims NNN 001 in an empty folder", async () => {
      const claim = await claimExportName({ fs: fakeFs([]), ...base });
      expect(claim).toEqual({ relPath: "Mia/2026-09-29_photo_001.mp4", absPath: inMia("2026-09-29_photo_001.mp4"), n: 1 });
    });

    test("uses the folder name the disk stores in the relative path", async () => {
      const stored = await prepareExportFolder({
        fs: fakeFolderFs(api, { [at("export")]: { kind: "dir" }, [at("export", "Mia")]: { kind: "dir", real: at("export", "mia") } }),
        root: at("export"),
        safeName: "Mia",
        avatarId: AVATAR,
        caseInsensitive: true,
        api,
      });
      const claim = await claimExportName({ fs: fakeFs([]), ...base, folder: stored });
      expect(claim.relPath).toBe("mia/2026-09-29_photo_001.mp4");
    });

    test("moves to the next number when the first is taken", async () => {
      const fs = fakeFs([inMia("2026-09-29_photo_001.mp4")]);
      expect((await claimExportName({ fs, ...base })).relPath).toBe("Mia/2026-09-29_photo_002.mp4");
    });

    test("skips a run of taken numbers", async () => {
      const taken = [1, 2, 3, 5].map((n) => inMia(exportFileName("2026-09-29", "photo", n)));
      expect((await claimExportName({ fs: fakeFs(taken), ...base })).n).toBe(4);
    });

    test("a taken number with another letter case counts as taken on a case-insensitive disk", async () => {
      const fs = fakeFs([inMia("2026-09-29_PHOTO_001.MP4")], { caseInsensitive: true });
      expect((await claimExportName({ fs, ...base })).n).toBe(2);
    });

    test("a different kind or date does not collide", async () => {
      const fs = fakeFs([inMia("2026-09-29_mix_001.mp4"), inMia("2026-09-28_photo_001.mp4")]);
      expect((await claimExportName({ fs, ...base })).n).toBe(1);
    });

    test("goes past 999 into four digits", async () => {
      const taken = Array.from({ length: 999 }, (_, i) => inMia(exportFileName("2026-09-29", "photo", i + 1)));
      expect((await claimExportName({ fs: fakeFs(taken), ...base })).relPath).toBe("Mia/2026-09-29_photo_1000.mp4");
    });

    test("gives up after 999999 instead of producing a name the contract refuses", async () => {
      const fs: ExportNameFs = {
        createExclusive: async () => {
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        },
      };
      await expect(claimExportName({ fs, ...base, startAt: 999_998 })).rejects.toThrow(/no free name/);
    });

    test("propagates an error that is not a collision, without retrying", async () => {
      let calls = 0;
      const fs: ExportNameFs = {
        createExclusive: async () => {
          calls++;
          throw Object.assign(new Error("read-only"), { code: "EROFS" });
        },
      };
      await expect(claimExportName({ fs, ...base })).rejects.toThrow("read-only");
      expect(calls).toBe(1);
    });

    test("refuses a folder that was built by hand instead of coming from prepareExportFolder", async () => {
      const fs = fakeFs([]);
      // @ts-expect-error a hand-built folder is not a PreparedFolder
      await expect(claimExportName({ fs, ...base, folder: { name: "Mia", path: at("export", "Mia") } })).rejects.toThrow();
      expect(fs.made).toEqual([]);
    });

    test("refuses a kind that is not a token before touching the disk", async () => {
      const fs = fakeFs([]);
      await expect(claimExportName({ fs, ...base, kind: "Ph oto" })).rejects.toThrow();
      expect(fs.made).toEqual([]);
    });
  });
}

describe("claimExportName on the real disk", () => {
  async function withFolder(run: (folder: PreparedFolder, root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "studio-export-name-"));
    try {
      const folder = await prepareExportFolder({ fs: NODE_EXPORT_FOLDER_FS, root, safeName: "Mia", avatarId: AVATAR, caseInsensitive: process.platform !== "linux" });
      await run(folder, root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const base = { date: "2026-09-29", kind: "photo", fs: NODE_EXPORT_NAME_FS };

  test("leaves an empty placeholder file under the claimed name", async () => {
    await withFolder(async (folder) => {
      const claim = await claimExportName({ ...base, folder });
      expect((await readFile(claim.absPath)).byteLength).toBe(0);
      expect(await readdir(folder.path)).toEqual(["2026-09-29_photo_001.mp4"]);
    });
  });

  test("never overwrites a file the owner put there", async () => {
    await withFolder(async (folder) => {
      await claimExportName({ ...base, folder });
      await writeFile(join(folder.path, "2026-09-29_photo_001.mp4"), "the owner's video");
      const claim = await claimExportName({ ...base, folder });
      expect(claim.n).toBe(2);
      expect(await readFile(join(folder.path, "2026-09-29_photo_001.mp4"), "utf8")).toBe("the owner's video");
    });
  });

  test("twelve concurrent claims get twelve different names", async () => {
    await withFolder(async (folder) => {
      const claims = await Promise.all(Array.from({ length: 12 }, () => claimExportName({ ...base, folder })));
      expect(new Set(claims.map((c) => c.relPath)).size).toBe(12);
      expect((await readdir(folder.path)).length).toBe(12);
    });
  });

  test("every claimed relPath satisfies the contract", async () => {
    await withFolder(async (folder) => {
      const claim = await claimExportName({ ...base, folder });
      expect(RelativePath.safeParse(claim.relPath).success).toBe(true);
    });
  });
});

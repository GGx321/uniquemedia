import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeName, RelativePath, VideoKindToken } from "../shared/engine";
import { claimExportName, exportFileName, formatExportDate, kindToken, NODE_EXPORT_NAME_FS, safeName, type ExportNameFs } from "./exportName";

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
  "Con", "CON", "nul.txt", "aux", "PRN", "com1", "LPT9", "COM0", "Мия", "Ольга", "😀", "👩‍👩‍👧", "é", "ñ", "ß", "Ａｂｃ", "\u0000", "\n", "\t",
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

  test("falls back to the avatar id for a Cyrillic name", () => {
    expect(safeName("Мия", AVATAR)).toBe(AVATAR);
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

  test.each(["Con", "CON", "prn", "Aux", "NUL", "com1", "COM9", "lpt1", "LPT9", "com0"])("does not use the Windows device name %s as a folder", (name) => {
    expect(safeName(name, AVATAR)).toBe(AVATAR);
  });

  test("turns nul.txt into a name that is not a device (the dot becomes an underscore)", () => {
    expect(safeName("nul.txt", AVATAR)).toBe("nul_txt");
  });

  test("has no trailing dot or space, which Windows would strip", () => {
    expect(safeName("Mia. ", AVATAR)).toBe("Mia");
  });

  test("keeps at most 64 characters of a 200-character name", () => {
    const name = safeName("a".repeat(200), AVATAR);
    expect(name).toBe("a".repeat(64));
  });

  test("does not end on a separator after the 64-character cut", () => {
    const name = safeName(`${"a".repeat(63)} b`, AVATAR);
    expect(name).toBe("a".repeat(63));
  });

  test("a device name followed by more words is not a device name", () => {
    expect(safeName("con    xyz", AVATAR)).toBe("con_xyz");
    expect(isSafeName(safeName("con", AVATAR))).toBe(true);
  });

  test("does not read an avatar name that looks like a path as one", () => {
    expect(safeName("../../etc/passwd", AVATAR)).toBe("etc_passwd");
  });

  test("two case variants stay distinct strings (the folder merge on a case-insensitive disk is harmless)", () => {
    expect(safeName("MIA", AVATAR)).not.toBe(safeName("mia", AVATAR));
  });

  test("property: over 5000 hostile names the result is a SafeName and the full path always satisfies RelativePath", () => {
    const random = prng(20260929);
    for (let i = 0; i < 5000; i++) {
      const raw = hostileName(random);
      const name = safeName(raw, AVATAR);
      expect(isSafeName(name)).toBe(true);
      const relPath = `${name}/${exportFileName("2026-09-29", "collage3", 1 + Math.floor(random() * 999))}`;
      expect(RelativePath.safeParse(relPath).success).toBe(true);
    }
  });

  test("property: a name that is already valid comes back unchanged", () => {
    const random = prng(7);
    const alphabet = "abcXYZ019_-";
    for (let i = 0; i < 500; i++) {
      let raw = "";
      const length = 1 + Math.floor(random() * 30);
      for (let j = 0; j < length; j++) raw += alphabet[Math.floor(random() * alphabet.length)];
      const core = raw.replace(/^[_-]+|[_-]+$/g, "");
      if (core === "" || !isSafeName(core)) continue;
      expect(safeName(core, AVATAR)).toBe(core);
    }
  });

  test("an avatar id that is itself hostile still gives a valid folder", () => {
    expect(isSafeName(safeName("Мия", "CON"))).toBe(true);
    expect(isSafeName(safeName("Мия", "😀"))).toBe(true);
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

describe("claimExportName with a fake disk", () => {
  /** An in-memory folder: `createExclusive` fails with EEXIST for a taken path, comparing case-insensitively when asked. */
  function fakeFs(taken: string[], opts: { caseInsensitive?: boolean } = {}): ExportNameFs & { made: string[]; dirs: string[] } {
    const norm = (p: string) => (opts.caseInsensitive === true ? p.toLowerCase() : p);
    const files = new Set(taken.map(norm));
    const made: string[] = [];
    const dirs: string[] = [];
    return {
      made,
      dirs,
      async mkdir(path) {
        dirs.push(path);
      },
      async createExclusive(path) {
        if (files.has(norm(path))) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        files.add(norm(path));
        made.push(path);
      },
    };
  }

  const base = { root: "/export", safeName: "Mia", date: "2026-09-29", kind: "photo" };

  test("claims NNN 001 in an empty folder", async () => {
    const fs = fakeFs([]);
    const claim = await claimExportName({ fs, ...base });
    expect(claim).toEqual({ relPath: "Mia/2026-09-29_photo_001.mp4", absPath: join("/export", "Mia", "2026-09-29_photo_001.mp4"), n: 1 });
  });

  test("creates the avatar's folder before claiming", async () => {
    const fs = fakeFs([]);
    await claimExportName({ fs, ...base });
    expect(fs.dirs).toEqual([join("/export", "Mia")]);
  });

  test("moves to the next number when the first is taken", async () => {
    const fs = fakeFs([join("/export", "Mia", "2026-09-29_photo_001.mp4")]);
    const claim = await claimExportName({ fs, ...base });
    expect(claim.relPath).toBe("Mia/2026-09-29_photo_002.mp4");
  });

  test("skips a run of taken numbers", async () => {
    const taken = [1, 2, 3, 5].map((n) => join("/export", "Mia", exportFileName("2026-09-29", "photo", n)));
    const claim = await claimExportName({ fs: fakeFs(taken), ...base });
    expect(claim.n).toBe(4);
  });

  test("a taken number with another letter case counts as taken on a case-insensitive disk", async () => {
    const fs = fakeFs([join("/export", "Mia", "2026-09-29_PHOTO_001.MP4")], { caseInsensitive: true });
    const claim = await claimExportName({ fs, ...base });
    expect(claim.n).toBe(2);
  });

  test("a different kind or date does not collide", async () => {
    const fs = fakeFs([join("/export", "Mia", "2026-09-29_mix_001.mp4"), join("/export", "Mia", "2026-09-28_photo_001.mp4")]);
    expect((await claimExportName({ fs, ...base })).n).toBe(1);
  });

  test("goes past 999 into four digits", async () => {
    const taken = Array.from({ length: 999 }, (_, i) => join("/export", "Mia", exportFileName("2026-09-29", "photo", i + 1)));
    const claim = await claimExportName({ fs: fakeFs(taken), ...base });
    expect(claim.relPath).toBe("Mia/2026-09-29_photo_1000.mp4");
  });

  test("gives up after 999999 instead of producing a name the contract refuses", async () => {
    const fs: ExportNameFs = {
      mkdir: async () => undefined,
      createExclusive: async () => {
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      },
    };
    await expect(claimExportName({ fs, ...base, startAt: 999_998 })).rejects.toThrow(/no free name/);
  });

  test("propagates an error that is not a collision, without retrying", async () => {
    let calls = 0;
    const fs: ExportNameFs = {
      mkdir: async () => undefined,
      createExclusive: async () => {
        calls++;
        throw Object.assign(new Error("read-only"), { code: "EROFS" });
      },
    };
    await expect(claimExportName({ fs, ...base })).rejects.toThrow("read-only");
    expect(calls).toBe(1);
  });

  test("refuses an unsafe folder name before touching the disk", async () => {
    const fs = fakeFs([]);
    await expect(claimExportName({ fs, ...base, safeName: "CON" })).rejects.toThrow();
    await expect(claimExportName({ fs, ...base, safeName: "../x" })).rejects.toThrow();
    expect(fs.dirs).toEqual([]);
    expect(fs.made).toEqual([]);
  });

  test("refuses a kind that is not a token before touching the disk", async () => {
    const fs = fakeFs([]);
    await expect(claimExportName({ fs, ...base, kind: "Ph oto" })).rejects.toThrow();
    expect(fs.made).toEqual([]);
  });
});

describe("claimExportName on the real disk", () => {
  async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "studio-export-name-"));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const base = { safeName: "Mia", date: "2026-09-29", kind: "photo", fs: NODE_EXPORT_NAME_FS };

  test("leaves an empty placeholder file under the claimed name", async () => {
    await withDir(async (root) => {
      const claim = await claimExportName({ ...base, root });
      expect((await readFile(claim.absPath)).byteLength).toBe(0);
      expect(await readdir(join(root, "Mia"))).toEqual(["2026-09-29_photo_001.mp4"]);
    });
  });

  test("never overwrites a file the owner put there", async () => {
    await withDir(async (root) => {
      await claimExportName({ ...base, root });
      await writeFile(join(root, "Mia", "2026-09-29_photo_001.mp4"), "the owner's video");
      const claim = await claimExportName({ ...base, root });
      expect(claim.n).toBe(2);
      expect(await readFile(join(root, "Mia", "2026-09-29_photo_001.mp4"), "utf8")).toBe("the owner's video");
    });
  });

  test("twelve concurrent claims get twelve different names", async () => {
    await withDir(async (root) => {
      const claims = await Promise.all(Array.from({ length: 12 }, () => claimExportName({ ...base, root })));
      expect(new Set(claims.map((c) => c.relPath)).size).toBe(12);
      expect((await readdir(join(root, "Mia"))).length).toBe(12);
    });
  });

  test("every claimed relPath satisfies the contract", async () => {
    await withDir(async (root) => {
      const claim = await claimExportName({ ...base, root, safeName: safeName("Мия", AVATAR) });
      expect(RelativePath.safeParse(claim.relPath).success).toBe(true);
    });
  });
});

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// 3d.5's money rule, read off the source: the editor never spends a flashapi request. `music.refresh` (1 of 30 per 31 days) and
// `music.recoverQuotaLog` (closes the quota for 31 days) are sent by Settings only, after the owner confirms (3c.6). So no source
// file of the editor's screens (its tests aside) may name the store's two paid methods or the paid command itself; the music tab
// and card read `music.list`, `music.peaks` and `music.status`, which are free.

const MONTAGE = import.meta.dir;
const EDITOR = join(MONTAGE, "..", "EditorScreen.tsx");
const FORBIDDEN = ["confirmMusicRefresh", "confirmQuotaLogRecovery", '"music.refresh"', '"music.recoverQuotaLog"'] as const;

/** A path with `/` between its parts on every platform (Windows names them with a backslash). */
const posix = (path: string): string => path.split(sep).join("/");

/** A source file's name from screens/montage, `/`-separated: «MusicTab.tsx», «../EditorScreen.tsx». */
const nameOf = (file: string): string => posix(relative(MONTAGE, file));

/** The editor's source files: everything under screens/montage (tests and test kits aside) and EditorScreen.tsx. */
function sources(): string[] {
  const files = readdirSync(MONTAGE, { recursive: true, encoding: "utf8" })
    .filter((name) => {
      const path = posix(name);
      return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !/(^|\/)(testkit|screenKit)\.tsx?$/.test(path);
    })
    .map((name) => join(MONTAGE, name));
  return [...files, EDITOR];
}

describe("the editor never names a paid music command", () => {
  test("it reads the music tab's and card's sources at all (the guard is not empty)", () => {
    const names = sources().map(nameOf);
    expect(names).toEqual(expect.arrayContaining(["MusicTab.tsx", "MusicCard.tsx", "MusicTrack.tsx", "../EditorScreen.tsx"]));
  });

  test("no source of screens/montage or EditorScreen.tsx refers to a paid music method or command", () => {
    const found = sources().flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return FORBIDDEN.filter((word) => text.includes(word)).map((word) => `${nameOf(file)}: ${word}`);
    });
    expect(found).toEqual([]);
  });
});

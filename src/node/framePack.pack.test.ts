import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ffprobeStatic from "ffprobe-static";
import { DEFAULT_FRAME_PACK_DIR, listFrameBackgrounds } from "./framePack";

/**
 * The shipped background pack, checked as data. The repo is public and the
 * pack travels with every build, so what is in it has to be provably free to
 * redistribute and the right shape for the canvas.
 */

const FFPROBE = ffprobeStatic.path.replace("app.asar", "app.asar.unpacked");
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 400 * 1024;
const FREE_LICENCE = /^CC0\b/i;

interface Credit {
  file: string;
  source: string;
  author: string;
  licence: string;
}

function credits(): Credit[] {
  const parsed: unknown = JSON.parse(readFileSync(join(DEFAULT_FRAME_PACK_DIR, "CREDITS.json"), "utf8"));
  if (!Array.isArray(parsed)) throw new Error("CREDITS.json is not a list");
  return parsed.map((c: unknown) => {
    if (typeof c !== "object" || c === null) throw new Error("credit entry is not an object");
    const r = c as Record<string, unknown>;
    // A missing field is a failure here, not the string "undefined".
    for (const key of ["file", "source", "author", "licence"] as const) {
      if (typeof r[key] !== "string") throw new Error(`credit for ${String(r.file)} has no ${key}`);
    }
    return { file: r.file as string, source: r.source as string, author: r.author as string, licence: r.licence as string };
  });
}

test("the pack holds at least 24 backgrounds", async () => {
  expect((await listFrameBackgrounds(DEFAULT_FRAME_PACK_DIR)).length).toBeGreaterThanOrEqual(24);
});

test("every background is a 1080x1920 JPEG", async () => {
  for (const file of await listFrameBackgrounds(DEFAULT_FRAME_PACK_DIR)) {
    const r = spawnSync(
      FFPROBE,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", file],
      { encoding: "utf8" }
    );
    expect(r.stdout.trim()).toBe("mjpeg,1080,1920");
  }
});

test("no background is over 400 KB and the whole pack is within 10 MB", async () => {
  let total = 0;
  for (const file of await listFrameBackgrounds(DEFAULT_FRAME_PACK_DIR)) {
    const size = statSync(file).size;
    expect(size).toBeLessThanOrEqual(MAX_FILE_BYTES);
    total += size;
  }
  expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
});

test("every background has a credit, and every credit a background", async () => {
  const files = (await listFrameBackgrounds(DEFAULT_FRAME_PACK_DIR)).map((f) => f.slice(DEFAULT_FRAME_PACK_DIR.length + 1));
  expect(credits().map((c) => c.file).sort()).toEqual(files);
});

test("every credit is CC0, with an author and a Commons source page", () => {
  for (const c of credits()) {
    expect(c.licence).toMatch(FREE_LICENCE);
    expect(c.author.trim().length).toBeGreaterThan(0);
    expect(c.author).not.toBe("undefined");
    expect(c.source).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
  }
});

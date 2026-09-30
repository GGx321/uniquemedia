import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectApng, STICKER_LIMITS } from "../../shared/stickers/apng";
import { STICKER_MANIFEST, stickerById } from "../../shared/stickers/manifest";
import { runFfmpegOk } from "../../engine/render/ffmpeg.testkit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { decodeFrames } from "./apngDecode.testkit";
import { DESIGNS } from "./designs";
import { buildCatalog, catalogJson, generateSticker, removeStaleStickers, renderStickerFrames, STICKER_ASSET_DIR, writeStickerSet, type GeneratedSticker } from "./generateStickers";
useNativeGlobals();

// The committed set under studio/assets/stickers/ must be exactly what the
// committed generator makes today. To change a sticker, edit its design, run
// `bun studio/scripts/stickers/generateStickers.ts` and commit the new files.

const GENERATOR = join(import.meta.dir, "generateStickers.ts");
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

// Every sticker is rendered once and shared by all the groups below.
const rendered = new Map<string, Uint8Array[]>();
let fresh: GeneratedSticker[] = [];
beforeAll(() => {
  for (const entry of STICKER_MANIFEST) rendered.set(entry.id, renderStickerFrames(entry));
  fresh = STICKER_MANIFEST.map((entry) => generateSticker(entry, rendered.get(entry.id)));
}, 300_000);

function framesOf(id: string): Uint8Array[] {
  const frames = rendered.get(id);
  if (frames === undefined) throw new Error(`no rendered frames for ${id}`);
  return frames;
}

describe("the designs", () => {
  test("cover exactly the manifest's ids", () => {
    expect(Object.keys(DESIGNS).sort()).toEqual(STICKER_MANIFEST.map((s) => s.id).sort());
  });
});

/** Mean absolute difference of two frames on premultiplied RGBA: the colour of an invisible pixel does not count. */
function premultipliedDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const aa = (a[i + 3] ?? 0) / 255;
    const ab = (b[i + 3] ?? 0) / 255;
    for (let c = 0; c < 3; c++) sum += Math.abs((a[i + c] ?? 0) * aa - (b[i + c] ?? 0) * ab);
    sum += Math.abs((a[i + 3] ?? 0) - (b[i + 3] ?? 0));
  }
  return sum / a.length;
}

/**
 * Judges the step from the last frame back to the first against the steps on
 * either side of it (0 to 1, and n-2 to n-1). A seam step of 0 means the last
 * frame repeats the first (the `t = i / (n - 1)` off-by-one: a visible stall on
 * every loop); a seam step far above its neighbours is a jump. Returns the
 * problem, or undefined when the seam is like any other step.
 */
function seamProblem(frames: readonly Uint8Array[]): string | undefined {
  const at = (i: number): Uint8Array => frames[i] ?? new Uint8Array(0);
  const n = frames.length;
  const seam = premultipliedDiff(at(n - 1), at(0));
  const neighbours = [premultipliedDiff(at(0), at(1)), premultipliedDiff(at(n - 2), at(n - 1))];
  for (const step of neighbours) {
    if (seam < step * 0.25) return `the seam step ${seam.toFixed(3)} is under 0.25x its neighbour ${step.toFixed(3)} (a stall)`;
    if (seam > step * 2.5) return `the seam step ${seam.toFixed(3)} is over 2.5x its neighbour ${step.toFixed(3)} (a jump)`;
  }
  return undefined;
}

/** The one loop that restarts on purpose: a strike at frame 0 that decays. */
const RESTARTS_ON_PURPOSE = new Set(["lightning-flash"]);

describe("the seam check itself (negative controls)", () => {
  for (const id of ["sun-rays", "heart-pulse", "sparkle-twinkle"]) {
    test(`${id}: a sticky loop, whose last frame repeats the first, is caught`, () => {
      const frames = framesOf(id).slice();
      frames[frames.length - 1] = frames[0] ?? new Uint8Array(0);
      expect(seamProblem(frames)).toMatch(/stall/);
    });
    test(`${id}: a jump loop, cut at 80% of its length, is caught`, () => {
      const frames = framesOf(id).slice(0, Math.floor(framesOf(id).length * 0.8));
      expect(seamProblem(frames)).toMatch(/jump/);
    });
    test(`${id}: the real loop passes`, () => {
      expect(seamProblem(framesOf(id))).toBeUndefined();
    });
  }
});

describe("a generated sticker's frames", () => {
  for (const entry of STICKER_MANIFEST) {
    test(`${entry.id}: renders loopFrames frames of size*size RGBA`, () => {
      const frames = framesOf(entry.id);
      expect(frames.length).toBe(entry.loopFrames);
      for (const f of frames) expect(f.length).toBe(entry.size * entry.size * 4);
    });

    if (RESTARTS_ON_PURPOSE.has(entry.id)) {
      test(`${entry.id}: restarts on purpose, so its seam is a jump (the exception stays explicit)`, () => {
        expect(seamProblem(framesOf(entry.id))).toMatch(/jump/);
      });
    } else {
      test(`${entry.id}: the seam step is like its neighbours (0.25x to 2.5x), on premultiplied RGBA`, () => {
        expect(seamProblem(framesOf(entry.id))).toBeUndefined();
      });
    }

    test(`${entry.id}: has soft alpha (many pixels strictly between 0 and 255) and a transparent corner`, () => {
      const frame = framesOf(entry.id)[0] ?? new Uint8Array(0);
      let soft = 0;
      for (let i = 3; i < frame.length; i += 4) if ((frame[i] ?? 0) > 0 && (frame[i] ?? 0) < 255) soft += 1;
      expect(soft).toBeGreaterThan(400);
      expect(frame[3]).toBe(0);
    });
    test(`${entry.id}: moves (its frames are not all identical)`, () => {
      const frames = framesOf(entry.id);
      const first = frames[0] ?? new Uint8Array(0);
      expect(frames.some((f) => Buffer.compare(f, first) !== 0)).toBe(true);
    });
  }
});

describe("the committed set", () => {
  test("has one file per manifest sticker, plus catalog.json, and nothing else", () => {
    expect(readdirSync(STICKER_ASSET_DIR).sort()).toEqual([...STICKER_MANIFEST.map((s) => `${s.id}.apng`), "catalog.json"].sort());
  });

  test("regenerating gives one file per manifest sticker", () => {
    expect(fresh.map((f) => f.entry.id)).toEqual(STICKER_MANIFEST.map((s) => s.id));
  });

  for (const entry of STICKER_MANIFEST) {
    test(`${entry.id}.apng equals a fresh generation, byte for byte`, () => {
      const generated = fresh.find((f) => f.entry.id === entry.id);
      const committed = existsSync(join(STICKER_ASSET_DIR, `${entry.id}.apng`)) ? readFileSync(join(STICKER_ASSET_DIR, `${entry.id}.apng`)) : undefined;
      expect(generated).toBeDefined();
      expect(committed).toBeDefined();
      expect(sha256(committed ?? new Uint8Array(0))).toBe(sha256(generated?.bytes ?? new Uint8Array(1)));
    });
  }

  test("catalog.json equals a fresh catalog (line endings normalised as a second guard beside .gitattributes)", () => {
    expect(readFileSync(join(STICKER_ASSET_DIR, "catalog.json"), "utf8").replaceAll("\r\n", "\n")).toBe(catalogJson(buildCatalog(fresh)));
  });

  test("catalog.json's sha256 and byte size match the files on disk", () => {
    const catalog: unknown = JSON.parse(readFileSync(join(STICKER_ASSET_DIR, "catalog.json"), "utf8"));
    const stickers = typeof catalog === "object" && catalog !== null && "stickers" in catalog && Array.isArray(catalog.stickers) ? catalog.stickers : [];
    expect(stickers.length).toBe(STICKER_MANIFEST.length);
    for (const s of stickers) {
      const id: unknown = s?.id;
      const bytes = readFileSync(join(STICKER_ASSET_DIR, `${String(id)}.apng`));
      expect(s.sha256).toBe(sha256(bytes));
      expect(s.bytes).toBe(bytes.length);
    }
  });

  for (const entry of STICKER_MANIFEST) {
    test(`${entry.id}.apng passes the validator: caps, size, frame count, 30 fps grid`, () => {
      const result = inspectApng(readFileSync(join(STICKER_ASSET_DIR, `${entry.id}.apng`)), STICKER_LIMITS);
      if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
      expect([result.info.width, result.info.height]).toEqual([entry.size, entry.size]);
      expect(result.info.frameCount).toBe(entry.loopFrames);
      expect(result.info.loopFrames).toBe(entry.loopFrames);
      expect(result.info.frames.every((f) => f.delayNum === 1 && f.delayDen === 30)).toBe(true);
    });
  }
});

describe("the committed files, decoded", () => {
  for (const entry of STICKER_MANIFEST) {
    test(`${entry.id}.apng inflates (system zlib) and unfilters to exactly the rendered frames`, () => {
      const decoded = decodeFrames(readFileSync(join(STICKER_ASSET_DIR, `${entry.id}.apng`)), entry.size, entry.size);
      const expected = framesOf(entry.id);
      expect(decoded.length).toBe(expected.length);
      decoded.forEach((d, i) => expect(Buffer.compare(d, expected[i] ?? new Uint8Array(0))).toBe(0));
    });

    test(`${entry.id}.apng decodes in ffmpeg with -xerror to loopFrames frames of the same pixels`, async () => {
      // ffmpeg exits 0 on a broken frame and drops it, so count the frames it delivers.
      const r = await runFfmpegOk(["-v", "error", "-xerror", "-f", "apng", "-i", join(STICKER_ASSET_DIR, `${entry.id}.apng`), "-vf", "fps=30,format=rgba", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
      const frameBytes = entry.size * entry.size * 4;
      expect(r.stderr).toBe("");
      expect(r.stdout.length).toBe(frameBytes * entry.loopFrames);
      const expected = framesOf(entry.id);
      for (let i = 0; i < entry.loopFrames; i++) {
        expect(Buffer.compare(r.stdout.subarray(i * frameBytes, (i + 1) * frameBytes), expected[i] ?? new Uint8Array(0))).toBe(0);
      }
    }, 60_000);
  }
});

describe("writing the set", () => {
  test("leaves foreign .apng files alone in any folder but the asset folder, and still writes the catalog", () => {
    const out = mkdtempSync(join(tmpdir(), "b5-write-"));
    try {
      writeFileSync(join(out, "foreign.apng"), "not ours");
      writeStickerSet(out, fresh, true);
      expect(readdirSync(out).sort()).toEqual([...fresh.map((f) => f.file), "catalog.json", "foreign.apng"].sort());
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
  test("removeStaleStickers deletes only .apng files that are not kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "b5-stale-"));
    try {
      for (const name of ["keep.apng", "stale.apng", "notes.txt"]) writeFileSync(join(dir, name), "x");
      removeStaleStickers(dir, new Set(["keep.apng"]));
      expect(readdirSync(dir).sort()).toEqual(["keep.apng", "notes.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("catalog.json records each sticker's poster frame, 0 unless the manifest says otherwise", () => {
    const catalog = buildCatalog(fresh);
    for (const s of catalog.stickers) expect(s.posterFrame).toBe(stickerById(s.id)?.posterFrame ?? 0);
  });
});

describe("determinism", () => {
  test("generating a sticker twice in one process gives the same bytes", () => {
    const entry = STICKER_MANIFEST.find((s) => s.id === "heart-pulse");
    if (entry === undefined) throw new Error("heart-pulse missing from the manifest");
    expect(sha256(generateSticker(entry).bytes)).toBe(sha256(generateSticker(entry).bytes));
    // Two full renders of a 48-frame sticker are CPU-bound (about 0.4 s each on a quiet machine): the bound is this test's
    // own, not Bun's default 5 s, so a loaded shared runner cannot cut it.
  }, 30_000);

  test("running the script in a fresh process reproduces the committed files", async () => {
    const out = mkdtempSync(join(tmpdir(), "b5-stickers-"));
    try {
      const proc = Bun.spawn([process.execPath, "--no-env-file", GENERATOR, "--out", out, "--only", "heart-pulse,confetti-fall"], { stdout: "pipe", stderr: "pipe" });
      const [code, err] = await Promise.all([proc.exited, Bun.readableStreamToText(proc.stderr)]);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(readdirSync(out).sort()).toEqual(["confetti-fall.apng", "heart-pulse.apng"]);
      for (const name of readdirSync(out)) {
        expect(sha256(readFileSync(join(out, name)))).toBe(sha256(readFileSync(join(STICKER_ASSET_DIR, name))));
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("the generator's own self-check", () => {
  test("refuses an entry whose design is missing", () => {
    expect(() => generateSticker({ id: "no-such-design", nameRu: "Нет", category: "mood", tags: ["a", "b"], size: 64, loopFrames: 4 })).toThrow(/design/);
  });
  test("refuses an entry over the pixel cap", () => {
    expect(() => generateSticker({ id: "heart-pulse", nameRu: "Сердце", category: "love", tags: ["a", "b"], size: 722, loopFrames: 4 })).toThrow(/size/);
  });
  test("refuses an entry over the loop cap", () => {
    expect(() => generateSticker({ id: "heart-pulse", nameRu: "Сердце", category: "love", tags: ["a", "b"], size: 64, loopFrames: 301 })).toThrow(/loop/);
  });
});

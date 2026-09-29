import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectApng, STICKER_LIMITS } from "../../shared/stickers/apng";
import { STICKER_MANIFEST } from "../../shared/stickers/manifest";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { DESIGNS } from "./designs";
import { buildCatalog, catalogJson, generateSticker, generateStickerSet, renderStickerFrames, STICKER_ASSET_DIR, type GeneratedSticker } from "./generateStickers";
useNativeGlobals();

// The committed set under studio/assets/stickers/ must be exactly what the
// committed generator makes today. To change a sticker, edit its design, run
// `bun studio/scripts/stickers/generateStickers.ts` and commit the new files.

const GENERATOR = join(import.meta.dir, "generateStickers.ts");
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

let fresh: GeneratedSticker[] = [];
beforeAll(() => {
  fresh = generateStickerSet();
}, 300_000);

describe("the designs", () => {
  test("cover exactly the manifest's ids", () => {
    expect(Object.keys(DESIGNS).sort()).toEqual(STICKER_MANIFEST.map((s) => s.id).sort());
  });
});

describe("a generated sticker's frames", () => {
  const meanAbsDiff = (a: Uint8Array, b: Uint8Array): number => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    return sum / a.length;
  };

  for (const entry of STICKER_MANIFEST) {
    test(`${entry.id}: renders loopFrames frames of size*size RGBA`, () => {
      const frames = renderStickerFrames(entry);
      expect(frames.length).toBe(entry.loopFrames);
      for (const f of frames) expect(f.length).toBe(entry.size * entry.size * 4);
    });
  }

  for (const entry of STICKER_MANIFEST.filter((e) => e.id !== "lightning-flash")) {
    test(`${entry.id}: the step from the last frame back to the first is no bigger than 2.5x the largest step inside the loop`, () => {
      const frames = renderStickerFrames(entry);
      let largest = 0;
      for (let i = 1; i < frames.length; i++) largest = Math.max(largest, meanAbsDiff(frames[i - 1] ?? new Uint8Array(0), frames[i] ?? new Uint8Array(0)));
      const wrap = meanAbsDiff(frames[frames.length - 1] ?? new Uint8Array(0), frames[0] ?? new Uint8Array(0));
      expect(wrap).toBeLessThanOrEqual(largest * 2.5);
    });
  }

  for (const entry of STICKER_MANIFEST) {
    test(`${entry.id}: has soft alpha (many pixels strictly between 0 and 255) and a transparent corner`, () => {
      const frame = renderStickerFrames(entry)[0] ?? new Uint8Array(0);
      let soft = 0;
      for (let i = 3; i < frame.length; i += 4) if ((frame[i] ?? 0) > 0 && (frame[i] ?? 0) < 255) soft += 1;
      expect(soft).toBeGreaterThan(400);
      expect(frame[3]).toBe(0);
    });
    test(`${entry.id}: moves (its frames are not all identical)`, () => {
      const frames = renderStickerFrames(entry);
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

describe("determinism", () => {
  test("generating a sticker twice in one process gives the same bytes", () => {
    const entry = STICKER_MANIFEST.find((s) => s.id === "heart-pulse");
    if (entry === undefined) throw new Error("heart-pulse missing from the manifest");
    expect(sha256(generateSticker(entry).bytes)).toBe(sha256(generateSticker(entry).bytes));
  });

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

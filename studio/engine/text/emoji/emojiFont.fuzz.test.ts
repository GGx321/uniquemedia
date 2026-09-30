import { beforeAll, describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { EmojiFontError, openEmojiFont } from "./emojiFont";
import { loadPinnedEmojiFont } from "./emojiFont.testkit";
useNativeGlobals();

// Mutated font bytes: `openEmojiFont` either throws an EmojiFontError or returns a font whose three lookups never
// throw and only hand out bitmaps that are PNGs. A hang cannot be caught in-thread, so each open is timed and one
// that takes long fails the test (and the run's alarm catches a real infinite loop).

const SEED = 0x5eed_4a11;
const MAX_MS_PER_OPEN = 5000; // hang detection, not a benchmark: each open copies 10 MB, so a Windows runner can stall a GC for a second

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Span {
  name: string;
  start: number;
  length: number;
}

const PROBES: (string | number[])[] = ["😀", "👩‍💻", "👨‍👩‍👧‍👦", "👍🏽", "🇺🇸", "1️⃣", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "❤️", "😀‍😀", "", [0x1f600], [-1], ["x".codePointAt(0) ?? 0]];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let pristine: Uint8Array;
let spans: Span[];

beforeAll(async () => {
  pristine = await loadPinnedEmojiFont();
  const view = new DataView(pristine.buffer);
  spans = [{ name: "directory", start: 0, length: 12 + 16 * view.getUint16(4) }];
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + 16 * i;
    const tag = String.fromCharCode(...pristine.subarray(record, record + 4));
    if (["maxp", "cmap", "GSUB", "CBLC"].includes(tag)) spans.push({ name: tag, start: view.getUint32(record + 8), length: view.getUint32(record + 12) });
    // The first bytes of CBDT and of the glyph records the tests read: its header, then the bitmaps' headers.
    if (tag === "CBDT") spans.push({ name: "CBDT", start: view.getUint32(record + 8), length: 4 }, { name: "CBDT glyph", start: view.getUint32(record + 8) + 1_557_285, length: 64 });
  }
});

interface Stats {
  runs: number;
  opened: number;
  refused: Map<string, number>;
  slowestMs: number;
}

/** Opens `bytes`, probes what opens, and throws on anything but a typed refusal. */
function exercise(bytes: Uint8Array, stats: Stats, label: string): void {
  stats.runs++;
  const started = performance.now();
  try {
    const font = openEmojiFont(bytes);
    stats.opened++;
    for (const probe of PROBES) {
      const bitmap = font.bitmap(probe);
      expect(font.has(probe)).toBe(bitmap !== null);
      if (bitmap !== null) expect([...bitmap.png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    }
  } catch (error) {
    if (!(error instanceof EmojiFontError)) throw new Error(`${label}: threw ${String(error)}`, { cause: error });
    stats.refused.set(error.code, (stats.refused.get(error.code) ?? 0) + 1);
  }
  const took = performance.now() - started;
  stats.slowestMs = Math.max(stats.slowestMs, took);
  if (took > MAX_MS_PER_OPEN) throw new Error(`${label}: took ${took.toFixed(0)} ms`);
}

function newStats(): Stats {
  return { runs: 0, opened: 0, refused: new Map(), slowestMs: 0 };
}

describe("mutated font bytes", () => {
  test("random byte changes inside the parsed tables never throw anything but a typed error", () => {
    const random = mulberry32(SEED);
    const stats = newStats();
    const bytes = pristine.slice();
    for (let run = 0; run < 3000; run++) {
      const span = spans[Math.floor(random() * spans.length)];
      if (span === undefined) throw new Error("no spans");
      const edits: [number, number][] = [];
      const changes = 1 + Math.floor(random() * 6);
      for (let c = 0; c < changes; c++) {
        const at = span.start + Math.floor(random() * span.length);
        edits.push([at, bytes[at] ?? 0]);
        const pick = random();
        bytes[at] = pick < 0.25 ? 0 : pick < 0.5 ? 0xff : pick < 0.6 ? (bytes[at] ?? 0) ^ 0x80 : Math.floor(random() * 256);
      }
      exercise(bytes, stats, `run ${run} (${span.name})`);
      for (const [at, value] of edits.reverse()) bytes[at] = value;
    }
    expect(stats.slowestMs).toBeLessThan(MAX_MS_PER_OPEN);
    expect(stats.refused.size + stats.opened).toBeGreaterThan(0);
    console.log(`fuzz random: ${stats.runs} runs, ${stats.opened} opened, refused ${JSON.stringify(Object.fromEntries(stats.refused))}, slowest ${stats.slowestMs.toFixed(1)} ms`);
  }, 120_000);

  test("every byte of the directory, maxp and the CBLC and cmap headers set to 0x00 and to 0xFF", () => {
    const stats = newStats();
    const bytes = pristine.slice();
    const swept = spans.filter((s) => ["directory", "maxp"].includes(s.name)).map((s): [number, number] => [s.start, s.start + s.length]);
    for (const name of ["CBLC", "cmap"]) {
      const span = spans.find((s) => s.name === name);
      if (span !== undefined) swept.push([span.start, span.start + Math.min(span.length, 256)]);
    }
    for (const [from, to] of swept) {
      for (let at = from; at < to; at++) {
        const original = bytes[at] ?? 0;
        for (const value of [0x00, 0xff]) {
          bytes[at] = value;
          exercise(bytes, stats, `byte ${at} = ${value}`);
        }
        bytes[at] = original;
      }
    }
    expect(stats.slowestMs).toBeLessThan(MAX_MS_PER_OPEN);
    console.log(`fuzz sweep: ${stats.runs} runs, ${stats.opened} opened, refused ${JSON.stringify(Object.fromEntries(stats.refused))}, slowest ${stats.slowestMs.toFixed(1)} ms`);
  }, 120_000);

  test("every truncation at a table boundary and at random lengths is refused or opens", () => {
    const random = mulberry32(SEED + 1);
    const stats = newStats();
    const lengths = spans.flatMap((s) => [s.start, s.start + 1, s.start + s.length - 1, s.start + s.length]);
    for (let i = 0; i < 400; i++) lengths.push(Math.floor(random() * pristine.byteLength));
    for (const length of lengths) exercise(pristine.subarray(0, Math.max(0, Math.min(length, pristine.byteLength))), stats, `truncated to ${length}`);
    expect(stats.slowestMs).toBeLessThan(MAX_MS_PER_OPEN);
    console.log(`fuzz truncation: ${stats.runs} runs, ${stats.opened} opened, refused ${JSON.stringify(Object.fromEntries(stats.refused))}, slowest ${stats.slowestMs.toFixed(1)} ms`);
  }, 120_000);

  test("random bytes of every small length are refused as not a font", () => {
    const random = mulberry32(SEED + 2);
    const stats = newStats();
    for (let length = 0; length < 300; length++) exercise(Uint8Array.from({ length }, () => Math.floor(random() * 256)), stats, `noise ${length}`);
    expect(stats.opened).toBe(0);
  });

  test("a font handed over as a view into a larger buffer opens and answers the same", () => {
    const padded = new Uint8Array(pristine.byteLength + 100);
    padded.fill(0xaa);
    padded.set(pristine, 50);
    const view = padded.subarray(50, 50 + pristine.byteLength);
    const font = openEmojiFont(view);
    expect(font.bitmap("😀")?.png.byteLength).toBe(3390);
  });
});

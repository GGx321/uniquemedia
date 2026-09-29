import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEmojiFont } from "../fonts";

// Test support for the emoji reader. Never imported by production code.
//
// The font is the committed studio/assets/fonts/NotoColorEmoji.ttf, read through `loadEmojiFont`, the same
// manifest-checked (sha256) loader the engine uses. No network, no second copy.

const HERE = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(HERE, "..", "..", "..", "assets", "fonts");

export const EMOJI_FONT_BYTES = 10_673_480;

let pending: Promise<Uint8Array> | null = null;

/** The committed Noto Color Emoji v2.051 bytes. A fresh copy each call, so a test may mutate it. */
export async function loadPinnedEmojiFont(): Promise<Uint8Array> {
  pending ??= loadEmojiFont(FONTS_DIR);
  const shared = await pending;
  // A copy: `loadEmojiFont` returns a Node Buffer, whose slice() would be a view.
  return new Uint8Array(shared);
}

export interface EmojiTestEntry {
  codePoints: number[];
  status: string;
  /** The "E<n>.<m>" version column, e.g. "E1.0". */
  since: string;
  name: string;
}

/** Parses Unicode's emoji-test.txt: `<hex code points> ; <status> # <emoji> E<version> <name>`. */
export function parseEmojiTest(text: string): EmojiTestEntry[] {
  const entries: EmojiTestEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([0-9A-F ]+?)\s*;\s*([a-z-]+)\s*#\s*\S+\s+(E\d+\.\d+)\s+(.*)$/.exec(line);
    if (match === null) throw new Error(`unparseable emoji-test line: ${line}`);
    const [, points = "", status = "", since = "", name = ""] = match;
    entries.push({ codePoints: points.split(" ").map((h) => Number.parseInt(h, 16)), status, since, name });
  }
  return entries;
}

export async function loadEmojiTest(): Promise<EmojiTestEntry[]> {
  return parseEmojiTest(await readFile(join(HERE, "fixtures", "emoji-test-17.0.txt"), "utf8"));
}

/** HarfBuzz's glyph id for each fully-qualified sequence (fixtures/emoji-test-17.0.hb-glyphs.txt), keyed by "1F600" / "1F469 200D 1F4BB". */
export async function loadHarfBuzzGlyphs(): Promise<Map<string, number>> {
  const text = await readFile(join(HERE, "fixtures", "emoji-test-17.0.hb-glyphs.txt"), "utf8");
  const glyphs = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    const [points = "", glyph = ""] = line.split(";").map((part) => part.trim());
    glyphs.set(points, Number.parseInt(glyph, 10));
  }
  return glyphs;
}

export function keyOf(codePoints: readonly number[]): string {
  return codePoints.map((c) => c.toString(16).toUpperCase().padStart(4, "0")).join(" ");
}

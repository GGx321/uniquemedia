import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Test support for the emoji reader. Never imported by production code.
//
// The 10.7 MB font is not committed twice: 3b.2 ships it as studio/assets/fonts/NotoColorEmoji.ttf, and this
// reader must not depend on that file, so the tests fetch the same pinned release into the gitignored repo-root
// `.cache/` and check its sha256 (the value 3b.2's manifest pins).

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

export const EMOJI_FONT_SHA256 = "72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b";
export const EMOJI_FONT_BYTES = 10_673_480;
const EMOJI_FONT_URL = "https://raw.githubusercontent.com/googlefonts/noto-emoji/v2.051/fonts/NotoColorEmoji.ttf";
const CACHE_FILE = join(REPO_ROOT, ".cache", "emoji-font", "NotoColorEmoji-v2.051.ttf");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readCached(): Promise<Uint8Array | null> {
  try {
    const bytes = new Uint8Array(await readFile(CACHE_FILE));
    return sha256(bytes) === EMOJI_FONT_SHA256 ? bytes : null;
  } catch {
    return null;
  }
}

/** node:https rather than fetch: the root testSetup.ts swaps the global fetch for happy-dom's, which enforces CORS. */
function download(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`emoji font fetch failed: HTTP ${response.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      response.on("error", reject);
    }).on("error", reject);
  });
}

let pending: Promise<Uint8Array> | null = null;

/** The pinned Noto Color Emoji v2.051 bytes. A fresh copy each call, so a test may mutate it. */
export async function loadPinnedEmojiFont(): Promise<Uint8Array> {
  pending ??= (async () => {
    const cached = await readCached();
    if (cached !== null) return cached;
    const bytes = await download(EMOJI_FONT_URL);
    if (sha256(bytes) !== EMOJI_FONT_SHA256) throw new Error("emoji font fetch: sha256 does not match the pinned release");
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    // Written beside and renamed, so a parallel test file never reads half a font.
    const temp = `${CACHE_FILE}.${process.pid}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, CACHE_FILE);
    return bytes;
  })();
  const shared = await pending;
  return shared.slice();
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

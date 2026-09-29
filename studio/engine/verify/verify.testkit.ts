import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { totalFrames } from "../../shared/montage";
import type { Clip } from "../../shared/engine/montage";
import { runFfmpegOk } from "../render/ffmpeg.testkit";
import { walkBoxes, type Box } from "../render/mp4Boxes.testkit";
import { buildPass1 } from "../render/pass1";
import { buildPass2 } from "../render/pass2";
import { makeWorkDir, readBytes, runPass1, runPass2 } from "../render/render.testkit";

// Test support for the output verifier: one short REAL render (pass 1 and
// pass 2 of 3a.5's builder, on the bundled ffmpeg) and byte-level tampering
// of copies of it. Test-only: never imported by production code.

const SOURCE = join(import.meta.dir, "../face/fixtures/images/render-best-home-1.jpg");
const scene = (id: string) => ({ photo: { source: "scene" as const, photoId: id }, focus: { x: 0.5, y: 0.38 } });

/** 1.5 s: one Ken Burns photo and one pan, 45 frames at 30 fps. */
const CLIPS: Clip[] = [
  { clipId: "a", durationMs: 1000, transitionIn: "cut", kind: "photo", cell: scene("a"), motion: "kenburns" },
  { clipId: "b", durationMs: 500, transitionIn: "cut", kind: "photo", cell: scene("b"), motion: "pan" },
];
export const FIXTURE_FRAMES = 45;

export interface Fixture {
  readonly dir: string;
  /** The untouched pass-2 output. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Renders the fixture into a fresh temp folder; the caller removes `dir`. `preparePhoto` may alter the source photo first (to load it with metadata). */
export async function renderFixture(prefix: string, preparePhoto?: (photoPath: string) => Promise<void>): Promise<Fixture> {
  if (totalFrames(CLIPS) !== FIXTURE_FRAMES) throw new Error("fixture clips no longer add up to FIXTURE_FRAMES");
  const dir = makeWorkDir(prefix);
  const photo = join(dir, "photo.jpg");
  copyFileSync(SOURCE, photo);
  if (preparePhoto) await preparePhoto(photo);
  await runPass1(buildPass1({ seed: 3, clips: CLIPS, resolvePhoto: () => ({ path: photo, width: 720, height: 1280 }), clipDir: dir }));
  const path = join(dir, "final.mp4");
  await runPass2(buildPass2({ clips: CLIPS, clipDir: dir, output: path, overlays: [], audio: { kind: "silent" } }));
  return { dir, path, bytes: readBytes(path) };
}

/** Writes `bytes` to a new file in the fixture's folder and returns its path. */
export function writeCopy(fx: Fixture, name: string, bytes: Uint8Array): string {
  const path = join(fx.dir, name);
  writeFileSync(path, bytes);
  return path;
}

// ---------------------------------------------------------------------------
// Locating and tampering (offsets come from 3a.5's independent box walker)
// ---------------------------------------------------------------------------

/** The `nth` box at `path`; throws when there is none (a tamper that changed nothing proves nothing). */
export function locate(bytes: Uint8Array, path: string, nth = 0): Box {
  const box = walkBoxes(bytes).filter((b) => b.path === path)[nth];
  if (!box) throw new Error(`no box ${path}[${nth}]`);
  return box;
}

const u32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A 32-bit-size box. `type` is four Latin-1 characters (`©` is 0xA9). */
export function makeBox(type: string, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (type.length !== 4) throw new Error(`box type must be 4 characters: ${type}`);
  return concat(u32(8 + payload.length), ascii(type), payload);
}

export function setU32(bytes: Uint8Array, at: number, value: number): void {
  bytes.set(u32(value), at);
}

/**
 * Replaces `deleteCount` bytes at absolute offset `at` (inside `target`) with
 * `insert`, and grows the 32-bit size of `target` and of every box around it
 * by the difference. `extraSizeAt` lists size fields of boxes the walker does
 * not open (a leaf's child, for example).
 */
export function spliceInside(bytes: Uint8Array, target: Box, at: number, deleteCount: number, insert: Uint8Array, extraSizeAt: readonly number[] = []): Uint8Array {
  const delta = insert.length - deleteCount;
  const out = concat(bytes.subarray(0, at), insert, bytes.subarray(at + deleteCount));
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const around = walkBoxes(bytes).filter((b) => b.start <= target.start && b.end >= target.end);
  for (const b of around) view.setUint32(b.start, view.getUint32(b.start) + delta);
  for (const offset of extraSizeAt) view.setUint32(offset, view.getUint32(offset) + delta);
  return out;
}

/** Appends `child` as the last child of the box at `parentPath`. */
export function appendChild(bytes: Uint8Array, parentPath: string, child: Uint8Array): Uint8Array {
  const parent = locate(bytes, parentPath);
  return spliceInside(bytes, parent, parent.end, 0, child);
}

/** The file with the top-level boxes `first` and `second` swapped, byte for byte. */
export function swapTopLevel(bytes: Uint8Array, first: string, second: string): Uint8Array {
  const a = locate(bytes, first);
  const b = locate(bytes, second);
  if (a.end > b.start) throw new Error(`${first} must come before ${second}`);
  return concat(bytes.subarray(0, a.start), bytes.subarray(b.start, b.end), bytes.subarray(a.end, b.start), bytes.subarray(a.start, a.end), bytes.subarray(b.end));
}

/** `bytes` with the box at `path` rewritten by `edit`, which gets a copy of the whole file. */
export function patched(bytes: Uint8Array, edit: (copy: Uint8Array) => void): Uint8Array {
  const copy = bytes.slice();
  edit(copy);
  return copy;
}

/** Remuxes `input` to `output` with the real ffmpeg, copying the streams; `extra` are output args. */
export async function remux(input: string, output: string, extra: readonly string[]): Promise<void> {
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-i", input, ...extra, output]);
}

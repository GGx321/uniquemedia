import { afterEach, beforeEach } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelativePath } from "../../../shared/engine";
import type { MontageShape } from "../../../shared/engine/montage";
import { NODE_EXPORT_FOLDER_FS, prepareExportFolder, type PreparedFolder } from "../../exportName";
import { checkExportRoot, NODE_EXPORT_ROOT_FS } from "../../exportRoot";
import { openLibrary, type Library } from "../../library";
import { PNG_1X1, SAMPLE_AVATAR, SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock } from "../../library/testing/helpers";
import type { AvatarManifest, PhotoSidecar } from "../../library/schemas";
import { NODE_COMMIT_FS, type CommitFs } from "../commitFs";
import { commitVideo, type CommitInput } from "../commit";
import { parseRecordSpec, partNameOf, videoPaths, type VideoRecord } from "../record";
import type { VerifiedFile } from "../../verify";
import type { z } from "zod";

// Test support for the video commit, its recovery, fileState and delete.
// Test-only: never imported by production code.

export const sha256Of = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** Deterministic pseudo-video bytes of a given length (not an MP4: tests that need the verifier use a real render). */
export function fakeVideoBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export interface World {
  readonly dir: string;
  readonly libraryRoot: string;
  readonly exportRoot: string;
  readonly renderTmp: string;
  readonly library: Library;
  readonly avatar: AvatarManifest;
  /** Three eligible scene photos of the avatar. */
  readonly photos: readonly PhotoSidecar[];
  readonly rootId: string;
  /** Reopens the library folder, as an engine restart does. */
  reopen(): Promise<Library>;
}

/** A library with one avatar and three scene photos, a marked export root, and a render-tmp folder, in a fresh temp dir per test. */
export function useWorld(): () => World {
  let world: World | undefined;
  let dir = "";
  // The setup writes files for a while (on Windows every write may stall on Defender); a test that times out in it must
  // not have its folder removed under the setup's feet (ENOENT after teardown), so the cleanup waits for it.
  let setup: Promise<void> = Promise.resolve();
  const build = async (): Promise<void> => {
    dir = await mkdtemp(join(tmpdir(), "studio-videos-"));
    const libraryRoot = join(dir, "library");
    const exportRoot = join(dir, "export");
    const renderTmp = join(dir, "render-tmp");
    await mkdir(libraryRoot);
    await mkdir(exportRoot);
    await mkdir(renderTmp);
    const deps = () => ({ now: steppingClock(), newId: sequentialIds() });
    const { library } = await openLibrary(libraryRoot, deps());
    const avatar = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Mia" });
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
    const active = await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
    // At once: `addPhoto` takes its id and time before its first await, so the call order stays the order of the photos.
    const photos: PhotoSidecar[] = await Promise.all(["home", "travel", "gym"].map((category) => library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category } }))));
    const check = await checkExportRoot({ fs: NODE_EXPORT_ROOT_FS, exportPath: exportRoot, libraryPath: libraryRoot, mayCreate: true, newId: randomUUID, now: () => new Date(), caseInsensitive: false });
    if (!check.ok) throw new Error(`test export root is unusable: ${check.reason}`);
    world = {
      dir,
      libraryRoot,
      exportRoot,
      renderTmp,
      library,
      avatar: active,
      photos,
      rootId: check.rootId,
      reopen: async () => (await openLibrary(libraryRoot, deps())).library,
    };
  };
  beforeEach(async () => {
    setup = build();
    await setup;
  });
  afterEach(async () => {
    world = undefined;
    await setup.catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return () => {
    if (world === undefined) throw new Error("the world exists only inside a test");
    return world;
  };
}

/** A one-clip spec over `photoIds` (one photo clip each), as the contract's shape (no 4 s minimum: a shape, not a saved spec). */
export function specOf(avatarId: string, photoIds: readonly string[], durationMs = 1000): z.infer<typeof MontageShape> {
  return {
    schemaVersion: 1,
    avatarId,
    layers: [],
    music: null,
    seed: 7,
    clips: photoIds.map((photoId, i) => ({
      clipId: `clip-${String(i + 1).padStart(8, "0")}`,
      kind: "photo" as const,
      cell: { photo: { source: "scene" as const, photoId }, focus: { x: 0.5, y: 0.4 } },
      motion: "static" as const,
      durationMs,
      transitionIn: "cut" as const,
    })),
  };
}

export interface SampleRecordOptions {
  videoId?: string;
  jobId?: string;
  photoIds?: readonly string[];
  relPath?: string;
  bytes?: Uint8Array;
  rootId?: string;
  mtimeMs?: number | undefined;
}

/** A complete record for `bytes` (default: 2 KiB of fake video) at `relPath` (default `Mia/2026-09-29_photo_001.mp4`). */
export function sampleRecord(world: World, options: SampleRecordOptions = {}): VideoRecord {
  const bytes = options.bytes ?? fakeVideoBytes(2048);
  const photoIds = options.photoIds ?? [world.photos[0]?.id ?? "photo-missing"];
  return {
    schemaVersion: 1,
    id: options.videoId ?? "video-00000001",
    avatarId: world.avatar.id,
    jobId: options.jobId ?? "job-00000001",
    createdAt: "2026-09-29T10:00:00.000Z",
    kind: "photo",
    durationMs: 1000 * photoIds.length,
    frames: 30 * photoIds.length,
    montageId: null,
    music: null,
    file: {
      rootId: options.rootId ?? world.rootId,
      relPath: RelativePath.parse(options.relPath ?? "Mia/2026-09-29_photo_001.mp4"),
      bytes: bytes.length,
      sha256: sha256Of(bytes),
      ...(options.mtimeMs === undefined ? {} : { mtimeMs: options.mtimeMs }),
    },
    spec: parseRecordSpec(specOf(world.avatar.id, photoIds)),
  };
}

// ---------- the fault layer ----------

/** Thrown by a simulated kill; nothing in the code under test may catch it and carry on. */
export class CrashError extends Error {
  constructor(readonly at: string) {
    super(`simulated crash at ${at}`);
    this.name = "CrashError";
  }
}

export type FsOp = keyof CommitFs;

export interface FaultyFs extends CommitFs {
  /** Every call, as `op path -> path`, in order. */
  readonly calls: string[];
  /** After this, every call throws CrashError: the process is gone, so no cleanup runs. The disk stays as the crash left it. */
  die(): void;
  readonly dead: boolean;
  /** Makes the next call of `op` that `when` accepts reject with `error`, once. */
  failOnce(op: FsOp, error: Error, when?: (args: readonly string[]) => boolean): void;
  /** Replaces some ops for the rest of the test. */
  override(patch: Partial<CommitFs>): void;
}

export function errnoError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/** `base` (the real disk) with a call log, one-shot failures, per-op overrides and a "dead process" switch. */
export function faultyFs(base: CommitFs = NODE_COMMIT_FS): FaultyFs {
  let dead = false;
  const calls: string[] = [];
  const failures: Array<{ op: FsOp; error: Error; when: (args: readonly string[]) => boolean }> = [];
  const patch: Partial<CommitFs> = {};
  /** Runs before every real call: a dead process does nothing, the call is logged, a scripted failure fires. */
  const enter = (op: FsOp, args: readonly string[]): void => {
    if (dead) throw new CrashError(`${op} after the process died`);
    calls.push(`${op} ${args.join(" -> ")}`);
    const index = failures.findIndex((f) => f.op === op && f.when(args));
    if (index >= 0) throw failures.splice(index, 1)[0]?.error;
  };
  return {
    calls,
    get dead() {
      return dead;
    },
    die: () => {
      dead = true;
    },
    failOnce: (op, error, when = () => true) => void failures.push({ op, error, when }),
    override: (next) => void Object.assign(patch, next),
    lstat: async (p) => (enter("lstat", [p]), (patch.lstat ?? base.lstat)(p)),
    realpath: async (p) => (enter("realpath", [p]), (patch.realpath ?? base.realpath)(p)),
    mkdir: async (p) => (enter("mkdir", [p]), (patch.mkdir ?? base.mkdir)(p)),
    createExclusive: async (p) => (enter("createExclusive", [p]), (patch.createExclusive ?? base.createExclusive)(p)),
    writeNew: async (p, text) => (enter("writeNew", [p]), (patch.writeNew ?? base.writeNew)(p, text)),
    fsyncFile: async (p) => (enter("fsyncFile", [p]), (patch.fsyncFile ?? base.fsyncFile)(p)),
    fsyncDir: async (p) => (enter("fsyncDir", [p]), (patch.fsyncDir ?? base.fsyncDir)(p)),
    rename: async (a, b) => (enter("rename", [a, b]), (patch.rename ?? base.rename)(a, b)),
    unlink: async (p) => (enter("unlink", [p]), (patch.unlink ?? base.unlink)(p)),
    link: async (a, b) => (enter("link", [a, b]), (patch.link ?? base.link)(a, b)),
    readdir: async (p) => (enter("readdir", [p]), (patch.readdir ?? base.readdir)(p)),
  };
}

// ---------- looking at a disk ----------

/** Every file under `dir` (relative, `/`-separated, sorted), skipping nothing: a leftover shows up. */
export async function listTree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listTree(dir, rel)));
    else out.push(rel);
  }
  return out.sort();
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size;
}

// ---------- the commit's inputs ----------


/** `<exportRoot>/Mia`, opened the way a render does. */
export async function openFolder(world: World, caseInsensitive = false): Promise<PreparedFolder> {
  return prepareExportFolder({ fs: NODE_EXPORT_FOLDER_FS, root: world.exportRoot, safeName: "Mia", avatarId: world.avatar.id, caseInsensitive });
}

/** Writes the finished temp a runner would leave: `<folder>/.studio-part-<jobId>.mp4`. */
export function writeTemp(folder: PreparedFolder, jobId: string, bytes: Uint8Array): string {
  const path = folder.fileIn(partNameOf(jobId));
  writeFileSync(path, bytes);
  return path;
}

/** A JPEG (as far as sniffing goes) whose EXIF Artist is `artist`: the shape of a source photo with an author in its metadata. */
export function jpegWithArtist(artist: string): Uint8Array {
  const text = [...Buffer.from(artist, "latin1"), 0];
  const entry = [0x3b, 0x01, 2, 0, text.length, 0, 0, 0, 26, 0, 0, 0]; // tag 0x013B (Artist), ASCII, the text at offset 26
  const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, ...entry, 0, 0, 0, 0, ...text];
  const payload = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
  const length = payload.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 255, ...payload, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

/** A verifier that accepts the file and hashes what it reads (so a later recovery can check the same sha). */
export const acceptingVerify = async (path: string): Promise<VerifiedFile> => {
  const bytes = readFileSync(path);
  return { result: { ok: true }, sha256: sha256Of(bytes), bytes: bytes.length };
};

// ---------- a commit rig ----------

export const MARKER = ".studio-export.json";


export interface Rig {
  readonly w: World;
  readonly fs: FaultyFs;
  readonly bytes: Uint8Array;
  readonly temp: string;
  readonly input: CommitInput;
  readonly logs: string[];
  target(): Parameters<typeof commitVideo>[0];
  run(over?: Partial<Parameters<typeof commitVideo>[2]>): ReturnType<typeof commitVideo>;
}

export async function rig(world: () => World, over: { bytes?: Uint8Array; forbiddenStrings?: string[]; input?: Partial<CommitInput> } = {}): Promise<Rig> {
  const w = world();
  const folder = await openFolder(w);
  const bytes = over.bytes ?? fakeVideoBytes(4096);
  const input: CommitInput = {
    jobId: "job-00000001",
    videoId: "video-00000001",
    avatarId: w.avatar.id,
    videoKind: "photo",
    date: "2026-09-29",
    createdAt: "2026-09-29T10:00:00.000Z",
    frames: 30,
    durationMs: 1000,
    montageId: null,
    music: null,
    spec: specOf(w.avatar.id, [w.photos[0]?.id ?? ""]),
    forbiddenStrings: over.forbiddenStrings ?? [],
    ...over.input,
  };
  const temp = writeTemp(folder, input.jobId, bytes);
  const fs = faultyFs();
  const logs: string[] = [];
  const target = { folder, root: w.exportRoot, rootId: w.rootId, caseInsensitive: false };
  return {
    w,
    fs,
    bytes,
    temp,
    input,
    logs,
    target: () => target,
    run: (extra = {}) => commitVideo(target, input, { fs, libraryRoot: w.libraryRoot, verify: acceptingVerify, log: (line) => logs.push(line), ...extra }),
  };
}

export const exportFiles = async (w: World) => (await listTree(w.exportRoot)).filter((f) => f !== MARKER);
export const libraryVideoFiles = async (w: World) => {
  try {
    return await listTree(videoPaths(w.libraryRoot, w.avatar.id).videosDir);
  } catch {
    return [];
  }
};
export const FINAL = "Mia/2026-09-29_photo_001.mp4";

/**
 * Runs `body` and returns every unhandled rejection the process reported while it ran (and two macrotask turns after: a
 * rejection is reported once the microtasks that could still handle it are done). The listener is removed in a `finally`,
 * so a body that throws never leaves it attached to swallow the reports of unrelated tests; the throw is passed on.
 */
export async function unhandledRejectionsDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
}

/** The failure a promise ended with, whatever it was. */
export async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the commit to fail");
}


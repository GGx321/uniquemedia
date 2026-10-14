import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineError, JobState } from "../../../shared/engine";
import type { UnsequencedEvent } from "../../../shared/engine/events";
import { EngineFailure } from "../../engineFailure";
import { checkExportRoot, NODE_EXPORT_ROOT_FS, type ExportRootCheck } from "../../exportRoot";
import { JobRegistry } from "../../jobs";
import { openLibrary, type Library } from "../../library";
import { openFileSource } from "../../media/video/fileSource";
import { probeVideo } from "../../media/video/videoProbe";
import { sequentialIds, steppingClock } from "../../library/testing/helpers";
import { NODE_COMMIT_FS } from "../../videos/commitFs";
import { CommitTracker } from "../../videos/live";
import { recoverVideos, type RecoveryReport } from "../../videos/recovery";
import { withRootLock } from "../../videos/rootLock";
import { runFfmpegArgv, type RunFfmpegArgvOptions } from "../../../node/runFfmpeg";
import { ClipExports, type ClipExportsDeps } from "../export";
import { clipExportArgv, type ExportFpsMode } from "../exportProfile";
import { ClipRecords } from "../records";
import type { ClipRecord } from "../schemas";
import { clipFilePath, clipsDirOf, ensureClipsDir, readClipRecord, writeClipRecord } from "../store";
import { useClipFixtures } from "./clipFixtures";
import { seedClipAvatar } from "./engineClipKit";
import { readyRecord } from "./recordsRig";

// Test-only (S5.V4c): a world for the clip export. A real library (an active «Nini» with her clips folder), a real export folder whose marker the real export check writes, the
// real records (their lock, their rewrite gate, their `fileState`), the real root lock and the render's live commits. The job registry, the events and the clip service's busy
// set are small stand-ins; time is a number the test owns (the export's `creation_time` is that number).

export const NOW = Date.parse("2026-10-14T09:30:15.000Z");

export interface ExportRigState {
  now: number;
  open: boolean;
  pendingDelete: Set<string>;
  busy: Set<string>;
  /** How many clip jobs hold the library (the clip service's `#work`). */
  work: number;
  /** What the export volume says is free; null: the real answer. */
  freeBytes: number | null;
  /** Replaces the whole export check when set. */
  exportCheck: ((requiredBytes?: number) => Promise<ExportRootCheck>) | null;
}

export interface ExportRig {
  readonly dir: string;
  readonly library: Library;
  readonly avatarId: string;
  readonly clipsDir: string;
  readonly exportRoot: string;
  /** `<export root>/Nini`. */
  readonly avatarFolder: string;
  readonly exports: ClipExports;
  readonly records: ClipRecords;
  readonly jobs: JobRegistry;
  readonly live: CommitTracker;
  readonly events: UnsequencedEvent[];
  readonly logs: string[];
  readonly state: ExportRigState;
  /** Fires the clip service's stop (a quit). */
  stop(): void;
  /** A ready clip whose mp4 is a copy of `source`, its size and hash in the record. */
  putClip(clipId: string, source: string, overrides?: Partial<ClipRecord>): Promise<ClipRecord>;
  record(clipId: string): Promise<ClipRecord>;
  /** `clips.export`: the job id, or the refusal. */
  start(clipId: string, avatarId?: string): Promise<{ jobId: string } | { error: EngineError }>;
  /** The job's id, or throws with the refusal. */
  started(clipId: string): Promise<string>;
  /** The job's final state once it left `running`. */
  settled(jobId: string): Promise<JobState>;
  /** The names in the avatar's export folder, sorted (nothing when it is not there). */
  folderNames(): Promise<string[]>;
  sha(path: string): Promise<string>;
  rootId(): Promise<string>;
  /** The render's recovery pass over the export folder, with `live` (default: the rig's own live commits). */
  recover(live?: CommitTracker): Promise<RecoveryReport>;
  cleanup(): Promise<void>;
}

export interface ExportRigOptions {
  readonly fps?: ExportFpsMode;
  readonly deps?: Partial<ClipExportsDeps>;
}

/**
 * The sources of the export tests, made by the bundled ffmpeg once per file, and a CLEAN EXPORT of the 720p one made with the real argv at `NOW` (duplicate mode): a fake encode
 * copies it, so a test of the commit does not run an encode. Call at the top level of a test file.
 */
export function useExportFixtures() {
  const clip = useClipFixtures();
  let prebuilt: Promise<string> | undefined;
  let tagged: Promise<string> | undefined;
  const fixtures = {
    /** Kling std: 720 x 1280, 24 fps, 1 s, no sound. */
    kling: () => clip({ width: 720, height: 1280, seconds: 1 }),
    /** Kling pro: 1080 x 1920. */
    pro: () => clip({ width: 1080, height: 1920, seconds: 1 }),
    /** Grok: 720 x 1280 with a sound track. */
    grok: () => clip({ width: 720, height: 1280, seconds: 1, audio: true }),
    /** Two video streams in one file. */
    twoVideos: () => clip({ width: 720, height: 1280, seconds: 1, secondVideo: true }),
    /** The real argv's file from `kling()`, exported at NOW (duplicate). */
    cleanExport: (): Promise<string> => {
      prebuilt ??= (async () => {
        const source = await fixtures.kling();
        const output = `${source}.export.mp4`;
        await runFfmpegArgv({ argv: clipExportArgv({ input: source, output, mode: "duplicate", colour: { matrix: 1, fullRange: false, dynamicRange: "sdr" }, exportedAt: new Date(NOW) }), output, timeoutMs: 120_000 });
        return output;
      })();
      return prebuilt;
    },
    /** The same export with one tag more (a title naming the provider): what I5.58 refuses, a whole file with a real sha256. */
    taggedExport: (): Promise<string> => {
      tagged ??= (async () => {
        const source = await fixtures.kling();
        const output = `${source}.tagged.mp4`;
        const argv = clipExportArgv({ input: source, output, mode: "duplicate", colour: { matrix: 1, fullRange: false, dynamicRange: "sdr" }, exportedAt: new Date(NOW) });
        await runFfmpegArgv({ argv: [...argv.slice(0, -3), "-metadata", "title=Kling clip", ...argv.slice(-3)], output, timeoutMs: 120_000 });
        return output;
      })();
      return tagged;
    },
  };
  return fixtures;
}

/**
 * An encode that writes the bytes of `file` over the output (truncating it in place, as ffmpeg's `-y` does: the job's temp keeps its inode) and reports `frames`; it runs `during`
 * first (a test's moment in the middle of an encode).
 */
export function copyingEncode(file: () => Promise<string>, options: { frames?: number; during?: (encode: RunFfmpegArgvOptions) => void | Promise<void> } = {}): NonNullable<ClipExportsDeps["encode"]> {
  return async (encode) => {
    await options.during?.(encode);
    encode.signal?.throwIfAborted();
    await writeFile(encode.output, await readFile(await file()));
    encode.onFrames?.(options.frames ?? 30);
  };
}

export async function createExportRig(options: ExportRigOptions = {}): Promise<ExportRig> {
  const dir = await mkdtemp(join(tmpdir(), "studio-clip-export-"));
  const libraryRoot = join(dir, "library");
  const exportRoot = join(dir, "export");
  await mkdir(libraryRoot);
  const { avatarId } = await seedClipAvatar(libraryRoot);
  const { library } = await openLibrary(libraryRoot, { now: steppingClock(), newId: sequentialIds("exportrig") });
  const clipsDir = clipsDirOf(library, avatarId);
  await ensureClipsDir(clipsDir);
  const state: ExportRigState = { now: NOW, open: true, pendingDelete: new Set(), busy: new Set(), work: 0, freeBytes: null, exportCheck: null };
  const stop = new AbortController();
  const events: UnsequencedEvent[] = [];
  const logs: string[] = [];
  const jobs = new JobRegistry();
  const live = new CommitTracker();
  let n = 0;
  const newId = (): string => `job-${String(++n).padStart(8, "0")}`;
  const exportStatus = (requiredBytes?: number): Promise<ExportRootCheck> => {
    if (state.exportCheck !== null) return state.exportCheck(requiredBytes);
    return checkExportRoot({
      fs: { ...NODE_EXPORT_ROOT_FS, freeBytes: async (path) => state.freeBytes ?? NODE_EXPORT_ROOT_FS.freeBytes(path) },
      exportPath: exportRoot,
      libraryPath: libraryRoot,
      mayCreate: true,
      newId: () => `root-${String(++n).padStart(8, "0")}`,
      now: () => new Date(state.now),
      caseInsensitive: true,
      ...(requiredBytes === undefined ? {} : { requiredBytes }),
    });
  };
  const host = {
    busy: (clipId: string) => state.busy.has(clipId),
    begin: (clipId: string) => {
      state.busy.add(clipId);
      state.work++;
      return () => {
        state.busy.delete(clipId);
        state.work--;
      };
    },
    stop: stop.signal,
  };
  const records = new ClipRecords({
    newId,
    clock: () => state.now,
    library: () => (state.open ? { hasAvatar: (id) => library.getAvatar(id) !== undefined, clipsDirOf: (id) => clipsDirOf(library, id) } : null),
    pendingDelete: (id) => state.pendingDelete.has(id),
    ledger: () => ({ lines: [], closeOf: () => undefined }),
    jobs,
    emit: (event) => void events.push(event),
    usableKey: () => "sk-test",
    openRouter: () => ({ downloadVideo: async () => ({ kind: "failed", cause: "network", httpStatus: null, detail: "not used" }) }),
    exportRoot: async () => {
      const check = await exportStatus();
      if (check.ok) return { root: check.root, rootId: check.rootId, caseInsensitive: true };
      return check.unanswered === true ? "unanswered" : null;
    },
    host,
    faceOf: async () => ({ verdict: "skipped", frames: 0, why: "worker" }),
    log: (line) => void logs.push(line),
  });
  const key = {};
  const exports = new ClipExports({
    newId,
    clock: () => state.now,
    log: (line) => void logs.push(line),
    library: () => (state.open ? { key, clipsDirOf: (id) => clipsDirOf(library, id), avatar: (id) => library.getAvatar(id) } : null),
    pendingDelete: (id) => state.pendingDelete.has(id),
    jobs,
    emit: (event) => void events.push(event),
    host,
    withClipLock: (clipId, work) => records.withClipLock(clipId, work),
    rewrite: (avatar, clipId, build) => records.rewrite(avatar, clipId, build),
    exportStatus,
    liveCommits: live,
    withRootLock: (root, work, lockOptions) => withRootLock(NODE_COMMIT_FS, root, work, lockOptions),
    exportNumbers: () => (state.open ? { library, libraryRoot } : null),
    fps: options.fps ?? "duplicate",
    ...options.deps,
  });
  const rig: ExportRig = {
    dir,
    library,
    avatarId,
    clipsDir,
    exportRoot,
    avatarFolder: join(exportRoot, "Nini"),
    exports,
    records,
    jobs,
    live,
    events,
    logs,
    state,
    stop: () => stop.abort(),
    async putClip(clipId, source, overrides = {}) {
      const target = clipFilePath(clipsDir, clipId);
      await copyFile(source, target);
      const bytes = await readFile(target);
      // The record says what the file is, as the download's validation wrote it: its size, length and rate from its own boxes.
      const opened = await openFileSource(target);
      const probe = await probeVideo(opened.source).finally(() => opened.close());
      const base = readyRecord({ id: clipId, avatarId });
      const facts = probe.ok ? { width: probe.info.video.width, height: probe.info.video.height, durationMs: Math.round(probe.info.durationMs), fps: probe.info.video.sourceFps } : {};
      const outcome = base.outcome.status === "ready" ? { ...base.outcome, ...facts, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } : base.outcome;
      const record = { ...base, outcome, ...overrides };
      await writeClipRecord(clipsDir, record);
      return record;
    },
    async record(clipId) {
      const read = await readClipRecord(clipsDir, clipId);
      if (read.kind !== "record") throw new Error(`no record of ${clipId}: ${read.kind}`);
      return read.record;
    },
    async start(clipId, avatar = avatarId) {
      try {
        return await exports.start({ avatarId: avatar, clipId });
      } catch (error) {
        if (error instanceof EngineFailure) return { error: error.error };
        throw error;
      }
    },
    async started(clipId) {
      const answer = await rig.start(clipId);
      if ("error" in answer) throw new Error(`the export was refused: ${JSON.stringify(answer.error)}`);
      return answer.jobId;
    },
    async settled(jobId) {
      for (let waited = 0; waited < 60_000; waited += 5) {
        const job = jobs.stateOf(jobId);
        if (job !== undefined && job.status !== "running") return job;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`job ${jobId} did not settle`);
    },
    async folderNames() {
      return (await readdir(join(exportRoot, "Nini")).catch(() => [])).sort();
    },
    async sha(path) {
      return createHash("sha256").update(await readFile(path)).digest("hex");
    },
    async rootId() {
      const check = await exportStatus();
      if (!check.ok) throw new Error(`the export folder is refused: ${check.reason}`);
      return check.rootId;
    },
    async recover(liveCommits = live) {
      return recoverVideos({ library, exportRoot: { root: exportRoot, rootId: await rig.rootId(), caseInsensitive: true }, live: liveCommits }, { scratchMinAgeMs: 0 });
    },
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
  return rig;
}

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClipExportLine } from "../../../shared/engine";
import type { UnsequencedEvent } from "../../../shared/engine/events";
import { JobRegistry } from "../../jobs";
import { Ledger, type LedgerLine } from "../../money/ledger";
import type { ExportRootRef } from "../../videos/recovery";
import { ClipRecords, type ClipRecordsDeps } from "../records";
import type { ClipRecord } from "../schemas";
import { clipAttemptId } from "../journal";
import { clipFilePath, clipRecordPath, ensureClipsDir, posterPath, writeClipRecord } from "../store";

// Test-only (S5.V4a2): a world for the clip records. A temp "library" holds one avatar's clips folder, the ledger is the real one over a file the test fills, and the service's neighbours (the job
// registry, the events, the busy set) are small fakes. Time is a number the test owns.

export const AVATAR = "avatar-aaaa-0001";
export const CLIP = "clip-0000001";
export const NOW = Date.parse("2026-10-13T12:00:00.000Z");
export const MINUTE = 60_000;
export const SHA = "a".repeat(64);
const AT = "2026-10-13T10:00:00.000Z";

export function readyRecord(overrides: Partial<ClipRecord> = {}): ClipRecord {
  const id = overrides.id ?? CLIP;
  return {
    schemaVersion: 1,
    id,
    avatarId: AVATAR,
    sourcePhotoId: "photo-0001",
    createdAt: AT,
    seen: false,
    motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    provider: { model: "kling-std", attempts: [{ attemptId: clipAttemptId(id, 1), providerJobId: "gen-abc123", outcome: "completed", providerCostMicros: 420_000, costSource: "usage" }] },
    recovered: false,
    exports: [],
    outcome: { status: "ready", file: `${id}.mp4`, posterFile: `${id}.poster.jpg`, width: 720, height: 1280, durationMs: 5_040, fps: 24, bytes: 1_000, sha256: SHA, face: { verdict: "match", p75: 0.7, frames: 10 } },
    ...overrides,
  };
}

export function failedRecord(reason: Extract<ClipRecord["outcome"], { status: "failed" }>["reason"], until: string | undefined, overrides: Partial<ClipRecord> = {}): ClipRecord {
  return readyRecord({ outcome: { status: "failed", reason, ...(until === undefined ? {} : { retryDownloadUntil: until }) }, ...overrides });
}

export const exportLine = (n = 1, overrides: Partial<ClipExportLine> = {}): ClipExportLine => ({
  rootId: "root-0000001",
  relPath: `Nini/2026-10-13_clip_${String(n).padStart(3, "0")}.mp4`,
  profile: "1080p30-interp",
  at: "2026-10-13T11:00:00.000Z",
  bytes: 2_000,
  sha256: "b".repeat(64),
  ...overrides,
});

export const reserve = (attemptId: string, clipId: string, worstMicros: number): LedgerLine => ({ type: "reserve", attemptId, jobId: clipId, scope: { avatarJobId: clipId }, model: "kwaivgi/kling-v3.0-std", worstMicros, at: AT });
export const settle = (attemptId: string, costMicros: number, estimated: boolean): LedgerLine => ({ type: "settle", attemptId, costMicros, estimated, at: AT });
export const release = (attemptId: string): LedgerLine => ({ type: "release", attemptId, reason: "never left", at: AT });

export interface RecordsRig {
  readonly dir: string;
  readonly clipsDir: string;
  readonly records: ClipRecords;
  readonly events: UnsequencedEvent[];
  readonly logs: string[];
  readonly state: { now: number; open: boolean; ledger: Ledger | null; root: ExportRootRef | null | "unanswered"; busy: Set<string>; avatars: Set<string>; pendingDelete: Set<string>; key: string };
  readonly jobs: JobRegistry;
  put(record: ClipRecord): Promise<void>;
  names(): Promise<string[]>;
  file(name: string): string;
  ledgerWith(lines: LedgerLine[]): Promise<void>;
  cleanup(): Promise<void>;
}

export interface RigOptions {
  deps?: Partial<ClipRecordsDeps>;
}

export async function createRecordsRig(options: RigOptions = {}): Promise<RecordsRig> {
  const dir = await mkdtemp(join(tmpdir(), "studio-clip-records-"));
  const avatarDir = join(dir, "avatars", AVATAR);
  const clipsDir = join(avatarDir, "clips");
  await mkdir(clipsDir, { recursive: true });
  const state: RecordsRig["state"] = { now: NOW, open: true, ledger: null, root: null, busy: new Set(), avatars: new Set([AVATAR]), pendingDelete: new Set(), key: "sk-test" };
  const events: UnsequencedEvent[] = [];
  const logs: string[] = [];
  const jobs = new JobRegistry();
  let nextId = 1;
  const deps: ClipRecordsDeps = {
    newId: () => `job-${String(nextId++).padStart(8, "0")}`,
    clock: () => state.now,
    library: () => (state.open ? { hasAvatar: (id) => state.avatars.has(id), clipsDirOf: (id) => join(dir, "avatars", id, "clips") } : null),
    pendingDelete: (id) => state.pendingDelete.has(id),
    ledger: () => state.ledger,
    jobs,
    emit: (event) => void events.push(event),
    usableKey: () => state.key,
    openRouter: () => ({ downloadVideo: async () => ({ kind: "failed", cause: "network", httpStatus: null, detail: "no client scripted" }) }),
    exportRoot: async () => state.root,
    host: {
      busy: (id) => state.busy.has(id),
      begin: (id) => {
        state.busy.add(id);
        return () => void state.busy.delete(id);
      },
      stop: new AbortController().signal,
    },
    faceOf: async () => ({ verdict: "skipped", frames: 0, why: "worker" }),
    log: (line) => void logs.push(line),
    ...options.deps,
  };
  await ensureClipsDir(clipsDir);
  return {
    dir,
    clipsDir,
    records: new ClipRecords(deps),
    events,
    logs,
    state,
    jobs,
    put: (record) => writeClipRecord(clipsDir, record),
    names: async () => (await readdir(clipsDir)).sort(),
    file: (name) => join(clipsDir, name),
    async ledgerWith(lines) {
      const path = join(dir, `ledger-${nextId++}.jsonl`);
      await writeFile(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
      state.ledger = await Ledger.open(path);
    },
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

export { clipFilePath, clipRecordPath, posterPath };

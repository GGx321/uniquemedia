import {
  AvatarDescriptor,
  type ApiKeyStatus,
  type MusicKeyStatus,
  type AvatarStatus,
  type AvatarSummary,
  type AvatarTraits,
  type Candidate,
  type CommandMessage,
  type CommandType,
  type Draft,
  type EngineError,
  type EngineNotice,
  type ExportStatus,
  type ExportUnavailableReason,
  type Estimate,
  EventLog,
  type EventMessage,
  type FailedCandidateSlot,
  type FileState,
  type ImageAgeCheck,
  IMPORT_FALLBACK_PRICE,
  type ImportPhotoPicked,
  type JobResult,
  type JobState,
  type LedgerUnavailable,
  MAX_LISTED_PHOTOS,
  MAX_LISTED_RUNS,
  type MediaUnsupportedReason,
  type MoneyHalt,
  type MoneyStatus,
  MUSIC_QUOTA_LIMIT,
  MUSIC_QUOTA_WINDOW_DAYS,
  type MusicQuotaLog,
  type MusicStatus,
  OkResponse,
  type PhotoQaSummary,
  type PhotoSummary,
  PROTOCOL_VERSION,
  type ReconcileReason,
  type ReconcileResult,
  type RenderConcurrency,
  type RenderResult,
  renderQueueFullDetail,
  type ResponseMessage,
  type RunRequest,
  type RunSummary,
  SceneCategory,
  type Settings,
  type Snapshot,
  type UnreadableAvatar,
  type UnsequencedEvent,
  type UsageUnknownReason,
  type VideoSummary,
} from "../../shared/engine";
import { MAX_LISTED_VIDEOS } from "../../shared/engine/video";
import { MAX_CLIPS, MAX_LISTED_MONTAGES, MAX_MONTAGE_ISSUES, Montage, montageIssues, type Focus, type MontageDraft, type MontageIssue, type TextLayer } from "../../shared/engine/montage";
import { defaultSpec, estimateBytes, estimateBytesUpper, notYetSupportedIssues, ownPhotoCells, ownPhotoIssues, totalFrames, trackIssues } from "../../shared/montage";
import { stickerIssues } from "../../shared/stickers/stickerIssues";
import { demoTracks, listedTracks, mockTrack, peaksOfTrack, storedTrack, type MockTrack, type MockTrackSeed } from "./mockMusicStore";
import { mockStickerBytes, mockStickerUrl } from "./mockStickers";
import { mockFolderName, MOCK_MAX_UNFINISHED_RENDERS, mockRelPath, sceneCells, videoKindOf } from "./mockRender";
import { MockTextPreviews } from "./mockText";
import { createEngineClient, type EngineBridge, type EngineClient } from "./client";
import { MockOwnMedia, type MockMediaAccept } from "./mockMedia";
import { realScheduler, type Scheduler } from "./scheduler";

// An in-memory engine that speaks the T0 wire protocol. It exists so the
// renderer can be built, tested and demoed before the real engine (T1) and
// its money path land. Every response it produces is parsed with the contract
// schema, and every event goes through the contract's EventLog, so a mock that
// drifts from the contract fails loudly in tests. It never makes images: the
// UI shows neutral placeholders for its photo ids.

const CANDIDATES_PER_JOB = 4;

/**
 * How long after avatars.cancel is accepted the job actually ends
 * (M-optimistic-cancel): the real engine's command answers before its abort
 * actually lands (engine.ts's #runCandidates settles the job later, once the
 * in-flight requests really stop), so the mock must not fold the two into
 * one synchronous step — that hid the bug this delay exists to catch.
 */
const CANCEL_CONFIRM_DELAY_MS = 50;

/** The mock price list, in micro-dollars: descriptor + 4 portraits + 4 age checks. */
export const DESCRIPTOR = { expected: 2_000, worst: 3_000 };
/**
 * The image age check's per-slot mock cost, folded into MOCK_ESTIMATE below
 * (owner's decision, 2026-09-27: off by default). Subtracted from the
 * baseline whenever `settings.imageAgeCheck` is "off" — see `#currentPrice`.
 */
export const MOCK_AGE_CHECK_PER_SLOT = { expected: 1_400, worst: 2_000 };
/** The attempt a mock settle-above-worst halt names. */
const MOCK_ABOVE_WORST_ATTEMPT = "mock-attempt#1";
export const MOCK_ESTIMATE: Readonly<Estimate> = {
  expectedMicros: 207_600, // 2_000 + 4 × 50_000 + 4 × 1_400 → "$0.21"
  worstMicros: 223_000, // 3_000 + 4 × 53_000 + 4 × 2_000 → "$0.23"
  prices: "live",
  pricesAsOf: "2026-09-24",
};
/**
 * T6c (import an existing avatar), L8: one mandatory one-time age check plus
 * up to two vision describe attempts — the shared IMPORT_FALLBACK_PRICE's own
 * whole-job number (plan.ts's importJobEstimate at the fallback prices),
 * never a separate copy of it, so the mock cannot drift from the real
 * engine's own computation. Unaffected by settings.imageAgeCheck, unlike the
 * candidate batches' own toggle-able check.
 */
export const MOCK_IMPORT_ESTIMATE: Readonly<Estimate> = {
  ...IMPORT_FALLBACK_PRICE.whole,
  prices: "live",
  pricesAsOf: IMPORT_FALLBACK_PRICE.asOf,
};
/** What the mock's one-off vision call would have written, stood in for the real photo it never actually looks at. */
const MOCK_IMPORT_TRAITS: AvatarTraits = {
  age: 26,
  ethnicity: "european",
  skinTone: "light",
  hairColor: "dark-brown",
  hairLength: "long",
  hairTexture: "straight",
  eyeColor: "brown",
  build: "slim",
  marks: [],
  vibe: "",
};

type RunCategory = RunRequest["categories"][number];

/**
 * T8b: the mock photo run's prices, in micro-dollars. One image attempt (always
 * 1K); a slot's worst case is every one of its paid attempts
 * (the real engine's RUN_ATTEMPTS_PER_SLOT); the scene writer's expected
 * share per photo and its worst case per chunk of photos it writes at once.
 * With the Photos mockup's own numbers: 20 photos are ≈ $1.01, до $3.07.
 */
export const MOCK_RUN_IMAGE = 50_000;
export const MOCK_RUN_ATTEMPTS_PER_SLOT = 3;
/** The writer's worst case per chunk is the real engine's (money/estimate.ts: 2 attempts × $0.0375, T5c's raised ceiling), so mock and engine prices agree to the micro-dollar. */
export const MOCK_RUN_WRITER = { expectedPerPhoto: 458, worstPerCall: 37_500, worstPerChunk: 75_000, photosPerChunk: 25 } as const;

/** The mock gate's similarity scores, cycled over a run's slots; every fifth slot carries none (a profile or back shot, or a photo from before the gate). */
const MOCK_FACE_COS = [0.86, 0.81, 0.71, 0.78] as const;
const MOCK_UNCHECKED_EVERY = 5;

const START_OF_TIME = Date.UTC(2026, 8, 24, 10, 0, 0);

/** The home folder the mock's settings live under; `settings.exportDisplay` shows it as «~», as main does for the real one. */
const MOCK_HOME = "/Users/studio";

function displayPath(path: string): string {
  return path === MOCK_HOME || path.startsWith(`${MOCK_HOME}/`) ? `~${path.slice(MOCK_HOME.length)}` : path;
}

/**
 * What main's own-media dialog answers in the mock (`pickMediaNext`): the files picked, each by DISPLAY NAME (the mock holds no path and
 * answers none) with the verdict the boundary gives it: a refusal (`reason`: with no importer yet, a good file is `not-yet-supported`), or
 * an acceptance (`accept`, 3f.1b: what the engine's importer would make of it) that starts an import job and ends in a record.
 */
export type MockMediaPick = { name: string; reason: MediaUnsupportedReason } | { name: string; accept: MockMediaAccept };
export type { MockMediaAccept, MockMediaFacts } from "./mockMedia";

/** What main's folder dialog answers in the mock (`pickExportFolderNext`). */
export interface MockExportPick {
  path: string;
  /** The reason the engine's check gives the folder; the pick is then refused and nothing changes. */
  refuse?: ExportUnavailableReason;
  /** The folder is the one that stood at this path before (moved or renamed by the owner): same marker, so the same identity. */
  movedFrom?: string;
  /** Some record files could not be read: the answer says its counts may be short. */
  incomplete?: boolean;
}

/**
 * A mock render announces this many progress steps (each `stepMs` apart, never reaching the total) before its saving phase, and
 * commits one step after that. The real engine's steps follow ffmpeg's frames (two passes folded into one range), so their count
 * differs: an intended difference the parity suite normalises.
 */
export const MOCK_RENDER_STEPS = 4;

/**
 * The `done` of the mock's progress step `step` (1 to `MOCK_RENDER_STEPS`) of a render of `total` frames, by the engine's own rule
 * (`ProgressFold`): pass 1 takes the first 35% of the range, pass 2 the rest, and the last frame (`total - 1` at most) belongs to
 * the job's end. So the bar of a mock render («Рендер · P %») climbs and stops where the engine's does, and the saving phase
 * keeps the last value.
 */
export function mockRenderDone(step: number, total: number): number {
  const pass1End = Math.floor((total * 35) / 100);
  if (step <= 1) return Math.min(total - 1, pass1End);
  const made = Math.floor((total * (step - 1)) / (MOCK_RENDER_STEPS - 1));
  return Math.min(total - 1, pass1End + Math.floor((made * (total - pass1End)) / total));
}

/** How many finished renders the snapshot keeps listing: the real registry's `KEEP_FINISHED`. */
const MOCK_KEEP_FINISHED_RENDERS = 50;

/** Where the mock's focus resolver puts the subject of a photo its face gate scored (the real one detects a face; the mock never looks at a pixel). */
export const MOCK_FOCUS = { x: 0.5, y: 0.35 } as const;

type SlotOutcome = "success" | "age-rejected" | "failed";

/**
 * Slot `step` (1-based) of a batch of `total`: the trailing `ageRejected`
 * slots are rejected by the age check, the `failedCount` right before them
 * fail with an error, and the rest succeed. Mirrors the contract's own
 * "unlucky tail" accounting (`FailedCandidateSlot`).
 */
function slotOutcome(step: number, total: number, ageRejected: number, failedCount: number): SlotOutcome {
  const fromEnd = total - step;
  if (fromEnd < ageRejected) return "age-rejected";
  if (fromEnd < ageRejected + failedCount) return "failed";
  return "success";
}

export interface MockEngineOptions {
  /** `demo` seeds a small library for the dev build; `empty` is a fresh install. */
  preset?: "empty" | "demo";
  /** 3e.2: with the `demo` preset, Mia also has videos in every file state (the dev build's «Видео» tab); off unless asked. */
  demoVideos?: boolean;
  scheduler?: Scheduler;
  /** Delay before each response; 0 answers on the next microtask. */
  latencyMs?: number;
  /** Time between a candidate job's progress steps. */
  stepMs?: number;
  apiKey?: ApiKeyStatus;
  musicKey?: MusicKeyStatus;
  /** The music list and the flashapi quota log the mock starts with (3c.6); none of either by default. */
  music?: MockMusicOptions;
  /** How many renders run at once (the setting's own values); «auto» is ONE in the mock, so a second render is visibly queued. */
  renderConcurrency?: RenderConcurrency;
  /** How long one text drawing takes on the mock's clock (the engine's worker draws one preview at a time); 0 draws in the next microtask. */
  textDrawMs?: number;
  eventCapacity?: number;
  avatars?: AvatarSummary[];
  drafts?: Draft[];
  unreadableAvatars?: UnreadableAvatar[];
  /** Overrides `unreadableTotal` above `unreadableAvatars.length` (L1): the real engine's list is bounded and cut, its total never is. */
  unreadableTotal?: number;
  /**
   * `halt`: paid calls halted as the engine reports it (e.g. a failed ledger
   * write, or a settle above worst known after a restart); `unavailable`: the
   * ledger could not be read, so there are no amounts at all.
   */
  money?: { spentMicros?: number; monthlyBudgetMicros?: number; halt?: MoneyHalt; unavailable?: LedgerUnavailable };
  /** Stored network concurrency (the contract allows 1–16). */
  concurrency?: number;
  /** Matches the app's own default, "off" (owner's decision, 2026-09-27). Tests that exercise the age-check path (MOCK_ESTIMATE's numbers, rejectNextByAgeCheck, ...) must set "on" explicitly. */
  imageAgeCheck?: ImageAgeCheck;
  /** Run photos already in the library (T8b's gallery), any order; `photos.list` answers them newest first. */
  photos?: PhotoSummary[];
  /** Per avatarId: run photos whose sidecar could not be read, counted in `photos.list`'s `skippedTotal`. */
  skippedPhotos?: Record<string, number>;
}

/** A photo run's slot: its category (the plan's), and how it ended — null while it is still open. */
interface MockRunSlot {
  category: RunCategory;
  end: "done" | "failed" | null;
}

/**
 * What the mock's music starts with (3c.6): the quota log's sends (each as days before the mock's start, oldest first), the
 * list the store holds, flashapi's last own figure, and the state of the log itself.
 */
export interface MockMusicOptions {
  sendsDaysAgo?: readonly number[];
  list?: { fetchedAt: string; trackCount: number; bytesOnDisk: number };
  /** The tracks the store holds (3d.1b): what `music.list` lists and `music.peaks` reads. With no `list`, the status counts them. */
  tracks?: readonly MockTrackSeed[];
  serverRemaining?: { value: number; daysAgo: number };
  quotaLog?: MusicQuotaLog;
}

/** The mock's music: what the engine keeps in its quota log and its track store, as plain numbers (mock clock, epoch ms). */
interface MockMusic {
  sends: number[];
  serverRemaining: { value: number; at: number } | null;
  quotaLog: MusicQuotaLog;
  list: { fetchedAt: number; trackCount: number; bytesOnDisk: number } | null;
  /** The stored tracks, in list order. */
  tracks: MockTrack[];
  refresh: MusicStatus["refresh"];
  /** How a scripted refresh ends instead of with a new list (`failNextMusicRefresh`). */
  nextFailure: EngineError | null;
}

const DAY_MS = 24 * 3600 * 1000;
const MUSIC_WINDOW_MS = MUSIC_QUOTA_WINDOW_DAYS * DAY_MS;
/** A mock refresh's steps: the list request, then the downloads (a track and a cover each, 30 tracks): the engine's total. */
const MOCK_MUSIC_TOTAL = 61;
const MOCK_MUSIC_STEPS = [1, 31, 61] as const;
/** What a mock refresh stores: 30 tracks of about 1.7 MB each. */
const MOCK_MUSIC_LIST = { trackCount: 30, bytesOnDisk: 52_400_000 } as const;
/** What one stored track weighs on disk, in the list a seed makes. */
const MOCK_TRACK_BYTES = 1_700_000;

/** The dev build's music: a list fetched three days before the mock's start, 12 requests in the window, flashapi's own 18 left. */
function demoMusic(): MockMusicOptions {
  // A function, not a constant: building the demo tracks at module load would keep them in a release bundle that drops the mock.
  return {
    sendsDaysAgo: [22, 19, 17, 15, 12, 10, 9, 7, 5, 4, 3, 1],
    list: { fetchedAt: "2026-09-21T11:02:00.000Z", trackCount: 30, bytesOnDisk: 94_000_000 },
    tracks: demoTracks(30),
    serverRemaining: { value: 18, daysAgo: 1 },
  };
}

/** The mock's music at its start: the seeded sends (days before `now`), the list, flashapi's figure and the log's state. */
function mockMusic(options: MockMusicOptions, now: number): MockMusic {
  return {
    sends: (options.sendsDaysAgo ?? []).map((days) => now - days * DAY_MS),
    serverRemaining: options.serverRemaining === undefined ? null : { value: options.serverRemaining.value, at: now - options.serverRemaining.daysAgo * DAY_MS },
    quotaLog: options.quotaLog ?? "ok",
    list:
      options.list !== undefined
        ? { fetchedAt: Date.parse(options.list.fetchedAt), trackCount: options.list.trackCount, bytesOnDisk: options.list.bytesOnDisk }
        : options.tracks === undefined || options.tracks.length === 0
          ? null
          : { fetchedAt: now, trackCount: options.tracks.length, bytesOnDisk: options.tracks.length * MOCK_TRACK_BYTES },
    tracks: (options.tracks ?? []).map(mockTrack),
    refresh: { state: "idle" },
    nextFailure: null,
  };
}

/**
 * What the engine's quota log says at `now` (studio/engine/music/quotaLedger.ts `summarize`), from the mock's numbers: a send
 * is in the window while `now < at + 31 days`; 30 sends, or a last server figure of 0 within the window, refuse a request.
 */
function mockQuota(music: MockMusic, now: number): { sent: number; refusal: "quota" | "floor" | null; nextFreeAt: number | null; serverRemaining: number | null } {
  const windowStart = now - MUSIC_WINDOW_MS;
  const times = music.sends.filter((at) => at > windowStart).sort((a, b) => a - b);
  const sent = times.length;
  const server = music.serverRemaining;
  const floorLiftsAt = server !== null && server.value === 0 ? server.at + MUSIC_WINDOW_MS : null;
  const floorActive = floorLiftsAt !== null && now < floorLiftsAt;
  const countBlocked = sent >= MUSIC_QUOTA_LIMIT;
  const countLiftsAt = countBlocked ? (times[sent - MUSIC_QUOTA_LIMIT] ?? 0) + MUSIC_WINDOW_MS : null;
  const blocked = [countLiftsAt, floorActive ? floorLiftsAt : null].filter((at): at is number => at !== null);
  const oldest = times[0];
  const nextFreeAt = blocked.length > 0 ? Math.max(...blocked) : oldest === undefined ? null : oldest + MUSIC_WINDOW_MS;
  return { sent, refusal: countBlocked ? "quota" : floorActive ? "floor" : null, nextFreeAt, serverRemaining: server !== null && server.at > windowStart ? server.value : null };
}

/** A persisted photo run (T6): it outlives its jobs, so a resume is a new job of the same run. */
interface MockRun {
  runId: string;
  avatarId: string;
  createdAt: string;
  request: RunRequest;
  /** The worst case accepted at start: the run's cap for its whole life, resumes included. */
  capMicros: number;
  /** Money settled for this run so far. */
  settledMicros: number;
  /** Whether the run checks age, captured at start like the real plan's `imageAgeCheck`: a resume keeps it. */
  ageCheck: boolean;
  slots: MockRunSlot[];
  photoIds: string[];
  /**
   * Whether the scene writer already answered for this run. A run stopped
   * before that has the writer's own ceiling in what a resume could still
   * spend, and in what its cap must still fund (the real engine's
   * `remainingPlan` counts an unwritten chunk the same way). The mock has no
   * writer phase of its own: a job marks it done as it starts.
   */
  writerDone: boolean;
}

interface MockRunJob {
  jobId: string;
  runId: string;
  avatarId: string;
  status: JobState["status"];
  done: number;
  total: number;
  error: EngineError | null;
  /** The reserve keys this job still holds open, one per slot it has not ended yet. */
  reserveKeys: string[];
  cancelTimers: (() => void)[];
}

/** The planner's split (scenes/planner.ts's `distribute`): `count` spread as evenly as possible, the remainder to the categories earliest in canonical order. */
function mockRunSlots(count: number, categories: readonly RunCategory[]): MockRunSlot[] {
  const ordered = SceneCategory.options.filter((c) => categories.includes(c));
  const base = Math.floor(count / ordered.length);
  const remainder = count % ordered.length;
  return ordered.flatMap((category, i) => Array.from({ length: base + (i < remainder ? 1 : 0) }, () => ({ category, end: null })));
}

function mockFaceQa(slotIndex: number): PhotoQaSummary | null {
  if (slotIndex % MOCK_UNCHECKED_EVERY === MOCK_UNCHECKED_EVERY - 1) return null;
  return { faceCos: MOCK_FACE_COS[slotIndex % MOCK_FACE_COS.length] ?? MOCK_FACE_COS[0] };
}

/**
 * What `avatars.rewriteDescriptor` restores a seeded `descriptor-invalid`
 * entry to: everything the resulting draft or saved avatar needs besides its
 * (freshly rewritten) descriptor, which `avatars.rewriteDescriptor` never
 * touches on the master photo, candidates or name.
 */
export interface RewriteTarget {
  status: "draft" | Exclude<AvatarStatus, "draft">;
  name: string;
  traits: AvatarTraits;
  /** Ignored for a draft: it has no master yet. */
  masterPhotoId?: string;
  createdAt?: string;
  photoCount?: number;
  /** A draft's existing candidates, kept through the rewrite exactly as the engine keeps them; ignored for a saved avatar. */
  candidates?: Candidate[];
}

interface MockJob {
  jobId: string;
  avatarId: string;
  status: JobState["status"];
  done: number;
  total: number;
  /** This job's own successes so far, added one at a time as each step lands. */
  candidates: Candidate[];
  rejectedByAgeCheck: number;
  /** Slots that gave no candidate, in step order: age-rejected and failed alike. */
  failedSlots: FailedCandidateSlot[];
  error: EngineError | null;
  cancelTimers: (() => void)[];
}

/** A rendered video the mock keeps: the record the windows see, the photos it shows, and the draft as the record was written. */
interface MockVideo {
  summary: VideoSummary;
  photoIds: string[];
  /** The draft it was rendered from AS WRITTEN: null when that draft was already deleted at commit. `videos.list` also shows null once it is deleted later. */
  montageId: string | null;
  /** What a check of its file finds, when the test says so; null = present (or `elsewhere` while the export folder is unusable). */
  fileState: FileState | null;
  /** The identity of the export folder it was made in (`exportRootId` then): a folder with another identity does not hold it. */
  rootId: string;
}

/** A render on the mock's queue: `queued` until a pool slot frees, then `running` through its progress and its saving phase. */
interface MockRenderJob {
  jobId: string;
  videoId: string;
  avatarId: string;
  /** The draft it was queued from: the job's events keep naming it even if the draft is deleted meanwhile. */
  montageId: string | null;
  /** The draft's name when the render was asked for (K12): the record keeps it. Null for an unnamed draft or a spec. */
  title: string | null;
  /** The job keeps the spec it was queued with: a later save or delete of the draft does not reach it. */
  spec: MontageDraft;
  photoIds: string[];
  /** The own media the spec names (3f.2): held against `media.delete` while the job is queued or running. */
  mediaIds: string[];
  status: JobState["status"];
  done: number;
  total: number;
  /** The commit has passed its point of no return: a cancel is ignored from here. */
  saving: boolean;
  /** A cancel was accepted while running: the job ends when its work has stopped, a moment later. */
  cancelling: boolean;
  error: EngineError | null;
  result: RenderResult | null;
  timers: (() => void)[];
}

const isActive = (j: { status: JobState["status"] }): boolean => j.status === "queued" || j.status === "running";

const SKIN: Record<AvatarTraits["skinTone"], string> = {
  "very-light": "very fair",
  light: "fair",
  "light-olive": "light olive",
  tan: "tan",
  dark: "deep brown",
  "very-dark": "very dark",
};
const HAIR: Record<AvatarTraits["hairColor"], string> = {
  black: "black",
  "dark-brown": "dark brown",
  chestnut: "chestnut",
  "light-brown": "light brown",
  blonde: "blonde",
  red: "red",
};
const LENGTH: Record<AvatarTraits["hairLength"], string> = { bob: "bob-length", shoulder: "shoulder-length", long: "long" };
const ETHNICITY: Record<AvatarTraits["ethnicity"], string> = {
  european: "European",
  latina: "Latina",
  asian: "Asian",
  african: "African",
  mixed: "mixed-heritage",
};
const MARKS: Record<AvatarTraits["marks"][number], string> = {
  freckles: "light freckles across the nose",
  mole: "a small mole on the cheek",
  dimples: "dimples",
  "nose-piercing": "a small nose piercing",
  "wrist-tattoo": "a small wrist tattoo",
};

/** What the descriptor LLM would write; built only from fixed English words, so it always passes the contract. */
export function mockDescriptor(t: AvatarTraits): { age: number; text: string } {
  const marks = t.marks.map((m) => MARKS[m]);
  const text =
    `${t.age}-year-old ${ETHNICITY[t.ethnicity]} woman, ${SKIN[t.skinTone]} skin, ${t.eyeColor} eyes, ` +
    `${LENGTH[t.hairLength]} ${t.hairTexture} ${HAIR[t.hairColor]} hair, ${t.build} build` +
    (marks.length > 0 ? `, ${marks.join(", ")}.` : ".");
  return { age: t.age, text };
}

const DEMO_TRAITS: AvatarTraits = {
  age: 25,
  ethnicity: "european",
  skinTone: "light-olive",
  hairColor: "chestnut",
  hairLength: "shoulder",
  hairTexture: "wavy",
  eyeColor: "hazel",
  build: "athletic",
  marks: ["freckles"],
  vibe: "girl next door, coffee, travel, books",
};

function demoAvatars(): AvatarSummary[] {
  const rows: [string, number, Partial<AvatarTraits>, AvatarSummary["status"]][] = [
    // Demo data consistency: matches seedDemoRun's own 8 done slots — photos.list's own count for Mia, exactly.
    ["Mia", 8, {}, "active"],
    ["Sofia", 86, { age: 27, hairColor: "black", hairLength: "long", hairTexture: "straight", eyeColor: "brown" }, "active"],
    ["Elena", 140, { age: 29, skinTone: "light", hairColor: "blonde", eyeColor: "blue", marks: [] }, "active"],
    ["Ava", 64, { age: 23, ethnicity: "latina", skinTone: "tan", hairTexture: "curly", marks: ["dimples"] }, "active"],
    ["Kira", 52, { age: 31, hairColor: "red", hairLength: "bob", eyeColor: "green", build: "slim" }, "active"],
    ["Nora", 118, { age: 26, ethnicity: "mixed", skinTone: "dark", hairColor: "dark-brown", marks: ["mole"] }, "archived"],
  ];
  return rows.map(([name, photoCount, patch, status], i) => {
    const traits = { ...DEMO_TRAITS, ...patch };
    const n = String(i + 1).padStart(4, "0");
    return {
      avatarId: `avatar-demo-${n}`,
      name,
      descriptor: mockDescriptor(traits),
      masterPhotoId: `photo-demo-${n}`,
      createdAt: new Date(START_OF_TIME - (i + 1) * 86_400_000 * 3).toISOString(),
      status,
      photoCount,
      // The mock has no videos yet (mock parity is task 3d.1b): every demo gallery photo is eligible and unused.
      videoCount: 0,
      eligibleUnusedCount: photoCount,
      usage: { state: "ok" },
    };
  });
}

/** `spec` with each scene photo's cell focus set from `focuses` (by photo id): what `montages.create` stores. */
function withFocus(spec: MontageDraft, focuses: ReadonlyMap<string, Focus | null>): MontageDraft {
  const focusOf = <C extends { photo: { source: string; photoId?: string } | null; focus: Focus | null }>(cell: C): C => {
    const photoId = cell.photo?.source === "scene" ? cell.photo.photoId : undefined;
    return photoId === undefined ? cell : { ...cell, focus: focuses.get(photoId) ?? null };
  };
  return {
    ...spec,
    clips: spec.clips.map((clip) => {
      if (clip.kind === "photo") return { ...clip, cell: focusOf(clip.cell) };
      if (clip.kind === "collage") return { ...clip, cells: clip.cells.map(focusOf) };
      return clip;
    }),
  };
}

export class MockEngine implements EngineBridge {
  /** Every command received, in order: tests assert on what the UI sent. */
  readonly calls: CommandMessage[] = [];
  /** The videos `videos.reveal` was asked to show (3d.6): the demo build has no main to open a file manager, so the mock only remembers. */
  readonly revealed: string[] = [];
  /** The avatars whose folder `videos.revealFolder` was asked to open (3e.2), in order: nothing opens in the mock. */
  readonly revealedFolders: string[] = [];

  private readonly scheduler: Scheduler;
  private readonly latencyMs: number;
  private readonly stepMs: number;
  private readonly capacity: number;
  private readonly listeners = new Set<(event: unknown) => void>();
  private log: EventLog;
  private boot = 1;
  private idCounter = 0;
  private clock = START_OF_TIME;
  private delivering = true;

  private settings: Settings;
  private avatars: AvatarSummary[];
  private drafts: Draft[];
  private unreadable: UnreadableAvatar[];
  private readonly unreadableTotalOverride: number | null;
  /** What a seeded `descriptor-invalid` entry recovers to, by avatarId; entries seeded without one (or for any other reason) cannot be rewritten. */
  private readonly rewritable = new Map<string, RewriteTarget>();
  private jobs: MockJob[] = [];
  private spentMicros: number;
  private spentSinceReconcile = 0;
  private readonly reserves = new Map<string, number>();
  private reconcileReasons: ReconcileReason[] = [];
  private halt: MoneyHalt | null;
  private readonly unavailable: LedgerUnavailable | null;
  private price: Estimate = { ...MOCK_ESTIMATE };
  /** T6c's own import price, settable apart from `price` above (the avatar-creation baseline): the two commands are priced independently by the real engine too. */
  private importPriceValue: Estimate = { ...MOCK_IMPORT_ESTIMATE };
  private rewritePriceOverride: Pick<Estimate, "expectedMicros" | "worstMicros"> | null = null;
  private encryptionAvailable: boolean;
  private readonly forced = new Map<CommandType, EngineError[]>();
  private readonly delayed = new Map<CommandType, number[]>();
  private readonly reconcileQueue: ReconcileResult[] = [];
  private ageRejectionsNextJob = 0;
  private failedSlotsNextJob: { count: number; error: EngineError; reserveLeftOpen: boolean } | null = null;
  private nextDraftEstimateMissing = false;
  /** Bumped whenever settings.setLibraryPath actually changes the folder, mirroring the real engine's Snapshot field. */
  private librarySwitchGeneration = 0;
  /**
   * T6c (L7): the ONE photo staged for import, like the real engine's own
   * single slot — a fresh stage replaces any earlier one, and importing
   * consumes it. Holds no real bytes (the mock never touches a file).
   */
  private stagedImportId: string | null = null;
  /** The next avatars.pickImportPhoto answers with this instead of a fresh staged photo. */
  private nextImportPick: ImportPhotoPicked | null = null;
  /** The next avatars.importAvatar's one-time age check fails: nothing is stored, AGE_CHECK_FAILED. */
  private nextImportAgeCheckFails = false;
  /** T6c review round 3, L4: see failNextImportAfterConsuming's own doc comment. */
  private nextImportFailure: EngineError | null = null;
  /** T8b: photo runs, oldest first (runs.list answers newest first), and their jobs. */
  private runs: MockRun[] = [];
  private runJobs: MockRunJob[] = [];
  /** Every stored run photo, oldest first (photos.list answers newest first). */
  private photos: PhotoSummary[];
  private readonly skippedPhotos: Record<string, number>;
  private runImagePrice = MOCK_RUN_IMAGE;
  /** The next run job's trailing `count` open slots end without a photo. */
  private failedRunSlotsNext = 0;
  /** seedRun's own id counter, apart from nextId's, so a seed never shifts the ids handed out later. */
  private seedCounter = 0;
  /** Test controls for the refusals a run start or resume can meet before it spends anything: see `setLibraryAvailable`, `setFaceGateAvailable`, `setAgeGateAvailable`, `removeMaster`. */
  private libraryOpen = true;
  private faceGate: { available: boolean; loadError?: string } = { available: true };
  private ageGateAvailable = true;
  private readonly mastersMissing = new Set<string>();
  /** What the engine's own look at the master (the gates' prepare) answers at a run start, per avatar. */
  private readonly masterPreflight = new Map<string, EngineError>();
  private focusAvailable = true;
  private skippedDrafts = 0;
  /** The montage drafts, in the order they were made; they outlive a restart, as the real engine's files do. */
  private montages = new Map<string, Montage>();
  /** Drafts deleted in this engine's life: a video's record stops naming them. */
  private readonly removedMontages = new Set<string>();
  private montageSeeds = 0;
  /** Committed videos, oldest first; `videos.list` answers newest first. */
  private videos: MockVideo[] = [];
  private renderJobs: MockRenderJob[] = [];
  /** The export folder as the disk has it, and as the last CHECK found it (the snapshot and `export.status` follow checks only). */
  private exportDisk: ExportStatus = { status: "ok" };
  private exportReported: ExportStatus = { status: "ok" };
  private exportFreeBytes: number | null = null;
  private renderQueueLimit = MOCK_MAX_UNFINISHED_RENDERS;
  /** The identity the export folder's marker holds (`rootId`): the videos made under it resolve only in a folder that holds it. */
  private exportRootId = "root-mock-0001";
  /** The export folders the mock has seen, by path, each with its identity: a folder the owner picks again gets its old one back. */
  private readonly exportFolders = new Map<string, string>();
  /** Files in each export folder (their `relPath`), by identity: «Удалить запись» leaves the file, so its name stays taken. */
  private readonly exportFilesByRoot = new Map<string, Set<string>>();
  private exportRootsMade = 1;
  /** What main's folder dialog answers next: a pick, `null` for a cancel, `undefined` for an unscripted one. */
  private exportPick: MockExportPick | null | undefined = undefined;
  private unscriptedPicks = 0;
  /** What main's own-media dialog answers next: the files picked, or `null` (and the default) for a cancel. */
  private mediaPick: readonly MockMediaPick[] | null = null;
  /** Own media's records and import jobs (3f.1b). */
  private readonly ownMedia: MockOwnMedia;
  private nextRenderFailure: { error: EngineError; at: "encode" | "saving" | "late" } | null = null;
  private music: MockMusic;
  private readonly textPreviews: MockTextPreviews;

  constructor(options: MockEngineOptions = {}) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.textPreviews = new MockTextPreviews({ scheduler: this.scheduler, drawMs: options.textDrawMs ?? 0, newId: () => this.nextId("preview") });
    this.latencyMs = options.latencyMs ?? 0;
    this.stepMs = options.stepMs ?? 700;
    this.ownMedia = new MockOwnMedia({ scheduler: this.scheduler, stepMs: this.stepMs, nextId: (prefix) => this.nextId(prefix), nowIso: () => this.nowIso(), emit: (event) => this.emit(event) });
    this.capacity = options.eventCapacity ?? 256;
    this.log = new EventLog(this.capacity, this.bootId());
    const apiKey = options.apiKey ?? { stored: true, last4: "3f2a", encryptionAvailable: true, rejected: false };
    this.encryptionAvailable = apiKey.encryptionAvailable;
    this.settings = {
      apiKey,
      // The dev build shows the Settings «Музыка» card as the artboard draws it: a stored RapidAPI key (3c.6).
      musicKey: options.musicKey ?? (options.preset === "demo" ? { stored: true, last4: "7c1e", rejected: false } : { stored: false, last4: null, rejected: false }),
      monthlyBudgetMicros: options.money?.monthlyBudgetMicros ?? 10_000_000,
      libraryPath: "/Users/studio/Studio/library",
      imageModel: "x-ai/grok-imagine-image-2.0",
      textModel: "x-ai/grok-4.3",
      concurrency: { network: options.concurrency ?? 6 },
      imageAgeCheck: options.imageAgeCheck ?? "off",
      exportPath: "/Users/studio/Studio/export",
      renderConcurrency: options.renderConcurrency ?? "auto",
    };
    this.exportFolders.set(this.settings.exportPath, this.exportRootId);
    this.avatars = options.avatars ?? (options.preset === "demo" ? demoAvatars() : []);
    this.drafts = options.drafts ?? [];
    this.unreadable = options.unreadableAvatars ?? [];
    this.unreadableTotalOverride = options.unreadableTotal ?? null;
    this.spentMicros = options.money?.spentMicros ?? (options.preset === "demo" ? 1_420_000 : 0);
    this.halt = options.money?.halt ?? null;
    this.unavailable = options.money?.unavailable ?? null;
    this.photos = [...(options.photos ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.skippedPhotos = { ...options.skippedPhotos };
    if (options.preset === "demo" && options.photos === undefined) this.seedDemoRun();
    this.music = mockMusic(options.music ?? (options.preset === "demo" ? demoMusic() : {}), this.clock);
    if (options.preset === "demo" && options.photos === undefined) this.seedDemoMontage();
    if (options.preset === "demo" && options.demoVideos === true && options.photos === undefined) this.seedDemoVideos();
  }

  /**
   * The dev build's draft as the Editor artboard draws it (3d.3b): four clips of Mia's demo photos, three texts on two rows,
   * two stickers and a track of the demo list started on one of its highlights. Choosing a track is the media panel's
   * (3d.5), so until then this is the one way the dev build shows the music track. Built in a method, never at module load:
   * the mock's demo data must not reach a release bundle.
   */
  private seedDemoMontage(): void {
    const mia = this.avatars.find((a) => a.name === "Mia");
    const photoIds = this.photos.filter((p) => p.avatarId === mia?.avatarId).map((p) => p.photoId);
    // The montage is 9.6 s: a highlight that leaves that much of the track.
    const fits = (h: { ms: number; likelyDefault: boolean }, durationMs: number): boolean => !h.likelyDefault && h.ms + 9_600 <= durationMs;
    const track = this.music.tracks.find((t) => t.summary.artist !== null && t.summary.highlights.some((h) => fits(h, t.summary.durationMs)));
    const [p1, p2, p3, p4, p5, p6] = photoIds;
    if (mia === undefined || p1 === undefined || p2 === undefined || p3 === undefined || p4 === undefined || p5 === undefined || p6 === undefined || track === undefined) return;
    const focus = (photoId: string) => ({ photo: { source: "scene" as const, photoId }, focus: this.focusOf(mia.avatarId, photoId) });
    const clip = { transitionIn: "cut" as const, motion: "kenburns" as const };
    const text = { kind: "text" as const, color: "#ffffff", x: 0.5, scale: 1 };
    const sticker = (layerId: string, stickerId: string, startMs: number, endMs: number) => ({ layerId, startMs, endMs, kind: "sticker" as const, sticker: { source: "builtin" as const, stickerId }, x: 0.741, y: 0.333, size: 0.203 });
    const highlight = track.summary.highlights.find((h) => fits(h, track.summary.durationMs))?.ms ?? 0;
    // Its own id and the clock's start, so no id or time the demo hands out afterwards moves.
    const montage = Montage.parse({
      montageId: "montage-demo-0001",
      name: "кафе и город",
      updatedAt: new Date(this.clock).toISOString(),
      spec: {
        schemaVersion: 1,
        avatarId: mia.avatarId,
        clips: [
          { ...clip, clipId: "clip-001", durationMs: 2_400, kind: "photo", cell: focus(p1) },
          { ...clip, clipId: "clip-002", durationMs: 3_200, kind: "collage", layout: "collage3", cells: [focus(p2), focus(p3), focus(p4)], stagger: true },
          { ...clip, clipId: "clip-003", durationMs: 2_000, kind: "photo", cell: focus(p5) },
          { ...clip, clipId: "clip-004", durationMs: 2_000, kind: "photo", cell: focus(p6) },
        ],
        layers: [
          { ...text, layerId: "layer-001", startMs: 300, endMs: 4_400, value: "sunday reset ☀️", font: "manrope", style: "plaque", y: 0.08 },
          { ...text, layerId: "layer-002", startMs: 1_000, endMs: 4_400, value: "slow morning in lisbon", font: "caveat", style: "none", y: 0.3 },
          sticker("layer-003", "sparkle-twinkle", 1_200, 4_900),
          { ...text, layerId: "layer-004", startMs: 5_800, endMs: 9_600, value: "coffee first ☕", font: "oswald", style: "outline", y: 0.45 },
          sticker("layer-005", "heart-pulse", 6_000, 9_600),
        ],
        music: { source: "trending", trackId: track.summary.trackId, startMs: highlight },
        seed: 1,
      },
    });
    this.montages.set(montage.montageId, montage);
  }

  /**
   * 3e.2: the dev build's Mia has videos, so the Photos «Видео» tab shows its cards as the artboard does: two in the export folder
   * (one with a track), one whose file the owner deleted, one changed outside Studio, one in a folder chosen before. Their photos
   * are used, and Mia's counts follow; one of her photos stays free, so a render can be tried. A dev-build convenience only: no
   * test of the engine's behaviour reads it.
   */
  private seedDemoVideos(): void {
    const mia = this.avatars.find((a) => a.name === "Mia");
    if (mia === undefined) return;
    // The demo draft (3d.3b) holds some of Mia's photos; a video must not take them, or the draft would show them as used.
    const drafted = new Set([...this.montages.values()].flatMap((m) => m.spec.clips.flatMap((c) => (c.kind === "photo" ? [c.cell] : c.kind === "collage" ? c.cells : [])).flatMap((cell) => (cell.photo?.source === "scene" ? [cell.photo.photoId] : []))));
    const track = this.music.tracks[0]?.summary;
    const oldRoot = this.newExportRootId();
    const plan: { title: string; photos: number; state: FileState | null; music: boolean; root?: string; daysAgo: number }[] = [
      { title: "кухня и кофе", photos: 2, state: null, music: true, daysAgo: 1 },
      { title: "пляж", photos: 1, state: null, music: false, daysAgo: 2 },
      { title: "в дороге", photos: 2, state: "missing", music: false, daysAgo: 3 },
      { title: "старый город", photos: 1, state: "changed", music: false, daysAgo: 4 },
      { title: "золотой час", photos: 1, state: null, music: false, root: oldRoot, daysAgo: 6 },
    ];
    // Mia's demo run drew 8 photos and the demo draft holds 6 of them: the videos get photos of their own, older ones from
    // the same run, so the draft's photos stay free and the run keeps its 8 recent ones (a dev-build convenience only).
    const needed = plan.reduce((sum, item) => sum + item.photos, 0);
    const free = this.photos.filter((p) => p.avatarId === mia.avatarId && !drafted.has(p.photoId));
    const template = this.photos.find((p) => p.avatarId === mia.avatarId);
    if (template === undefined) return;
    for (let n = free.length; n < needed; n++) {
      const photo = { ...template, photoId: `photo-demo-video-${String(n + 1).padStart(4, "0")}`, createdAt: new Date(START_OF_TIME - (30 + n) * 86_400_000).toISOString(), used: false, usedIn: [], rejected: false, reserved: false, eligible: true };
      this.photos.unshift(photo);
      free.push(photo);
    }
    const own = free.map((p) => p.photoId);
    let next = 0;
    for (const [i, item] of [...plan].reverse().entries()) {
      const photoIds = own.slice(next, next + item.photos);
      next += item.photos;
      if (photoIds.length < item.photos) return;
      const spec = defaultSpec(mia.avatarId, photoIds, 7 + i);
      const focused = withFocus(spec, new Map(photoIds.map((id) => [id, { x: 0.5, y: 0.35 }])));
      const kind = videoKindOf(spec.clips);
      const createdAt = new Date(START_OF_TIME - item.daysAgo * 86_400_000).toISOString();
      const relPath = mockRelPath(mockFolderName(mia.name, mia.avatarId), createdAt.slice(0, 10), kind, this.exportFiles);
      this.exportFiles.add(relPath);
      const summary: VideoSummary = {
        videoId: this.nextId("video"),
        avatarId: mia.avatarId,
        kind,
        durationMs: spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0),
        bytes: estimateBytes(spec.clips),
        createdAt,
        relPath,
        fileState: "present",
        montageId: null,
        photoCount: photoIds.length,
        music: item.music && track !== undefined ? { title: track.title, artist: track.artist, trackId: track.trackId } : null,
        hasPoster: false,
        title: item.title,
        firstClip: focused.clips[0] ?? null,
      };
      this.videos.push({ summary, photoIds, montageId: null, fileState: item.state, rootId: item.root ?? this.exportRootId });
    }
    const usable = this.photos.filter((p) => p.avatarId === mia.avatarId && this.photoUsable(mia.avatarId, p.photoId)).length;
    this.avatars = this.avatars.map((a) => (a.avatarId === mia.avatarId ? { ...a, photoCount: this.photos.filter((p) => p.avatarId === mia.avatarId).length, videoCount: this.videos.filter((v) => v.summary.avatarId === mia.avatarId).length, eligibleUnusedCount: usable } : a));
  }

  /** The dev build's Mia: a stopped run of 12 photos, 8 of them drawn, 4 left to resume. */
  private seedDemoRun(): void {
    const mia = this.avatars.find((a) => a.name === "Mia");
    if (mia === undefined) return;
    this.seedRun({ avatarId: mia.avatarId, count: 12, categories: ["home", "travel", "shoot", "glam", "fit"], poses: { profile: false, back: true } }, 8);
  }

  // ---------- EngineBridge ----------

  async request(command: CommandMessage): Promise<ResponseMessage> {
    this.calls.push(command);
    const delay = this.delayed.get(command.type)?.shift() ?? (this.latencyMs > 0 ? this.latencyMs : null);
    if (delay !== null) await new Promise<void>((resolve) => this.scheduler.schedule(delay, resolve));
    else await Promise.resolve();
    // A text preview is answered when the worker's lane has drawn it (or dropped it), not at once: the one command that waits.
    if (command.type === "montages.textPreview") return this.forcedFailure(command) ?? this.textPreview(command, command.payload.layer);
    return this.handle(command);
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- test and demo controls ----------

  /** The next `type` command fails with `error` before anything else is checked. */
  failNext(type: CommandType, error: EngineError): void {
    this.forced.set(type, [...(this.forced.get(type) ?? []), error]);
  }

  /**
   * The next `type` command answers after `ms` instead of the usual
   * `latencyMs`, so a test can observe a busy/cancelling UI state for exactly
   * that one command without slowing (or racing) anything else, including the
   * scheduler-driven job timers that share the same clock.
   */
  delayNext(type: CommandType, ms: number): void {
    this.delayed.set(type, [...(this.delayed.get(type) ?? []), ms]);
  }

  /** Changes the current price; a paid command accepted at a lower worst case gets PRICE_CHANGED. */
  setPrice(price: Pick<Estimate, "expectedMicros" | "worstMicros">): void {
    this.price = { ...this.price, ...price };
  }

  /** T6c: changes avatars.importAvatar's own price, apart from setPrice's avatar-creation baseline. */
  setImportPrice(price: Pick<Estimate, "expectedMicros" | "worstMicros">): void {
    this.importPriceValue = { ...this.importPriceValue, ...price };
  }

  /** Changes the descriptor-only rewrite's own price (otherwise DESCRIPTOR's), so a rewrite accepted lower gets PRICE_CHANGED. */
  setRewritePrice(price: Pick<Estimate, "expectedMicros" | "worstMicros">): void {
    this.rewritePriceOverride = price;
  }

  /**
   * `this.price` (the on-mode baseline, settable via `setPrice`) with the age
   * check's own cost taken back out when the setting is off — mirrors
   * plan.ts's `jobInput` treating `ageChecks` as null off, in this mock's own
   * flat-numbers model.
   */
  private currentPrice(): Estimate {
    if (this.settings.imageAgeCheck === "on") return this.price;
    const expectedMicros = Math.max(0, this.price.expectedMicros - CANDIDATES_PER_JOB * MOCK_AGE_CHECK_PER_SLOT.expected);
    const worstMicros = Math.max(0, this.price.worstMicros - CANDIDATES_PER_JOB * MOCK_AGE_CHECK_PER_SLOT.worst);
    return { ...this.price, expectedMicros, worstMicros };
  }

  /** OpenRouter answered 401: the key is marked rejected and running jobs fail with AUTH_INVALID. */
  rejectKey(): void {
    if (!this.settings.apiKey.stored) return;
    this.settings = { ...this.settings, apiKey: { ...this.settings.apiKey, rejected: true } };
    for (const job of this.jobs.filter((j) => j.status === "queued" || j.status === "running")) {
      this.failJob(job, { code: "AUTH_INVALID" });
    }
    for (const job of this.runJobs.filter((j) => j.status === "queued" || j.status === "running")) {
      this.failRunJob(job, { code: "AUTH_INVALID" });
    }
  }

  /** The mock's flashapi answered 401: the music key is marked rejected until it is replaced or cleared. */
  rejectMusicKey(): void {
    if (!this.settings.musicKey.stored) return;
    this.settings = { ...this.settings, musicKey: { ...this.settings.musicKey, rejected: true } };
    this.emitSettingsChanged();
  }

  /**
   * 3c.6: the next music refresh that is let through ends with `error` instead of a new list, after its request (it stays
   * counted, as a request that left does). A MUSIC_KEY_REJECTED marks the key rejected, as the engine's 401 does.
   */
  failNextMusicRefresh(error: EngineError): void {
    this.music = { ...this.music, nextFailure: error };
  }

  /**
   * 3c.6: the quota log as the disk left it: a damaged line (`corrupt`), a file that cannot be read (`unreadable`), a line
   * waiting to be written (`held`), gone with the music folder while its marker remains (`missing`), or sound again (`ok`). Nothing is announced: the engine finds out when it reads the log.
   */
  setMusicQuotaLog(state: MusicQuotaLog): void {
    this.music = { ...this.music, quotaLog: state };
  }

  /**
   * 3d.1b: the store holds exactly these tracks now, as if a refresh had stored them (the list, its time and its count follow).
   * Nothing is announced, as the engine announces nothing when a track is stored by another route.
   */
  seedMusicTracks(seeds: readonly MockTrackSeed[]): void {
    this.music = { ...this.music, tracks: seeds.map(mockTrack), list: { fetchedAt: this.clock, trackCount: seeds.length, bytesOnDisk: seeds.length * MOCK_TRACK_BYTES } };
  }

  /**
   * 3d.1b: while held, a text drawing that has started waits for `releaseTextDrawing`, so a test can queue previews behind it.
   * Letting go (false) also ends the drawing that waits.
   */
  holdTextDrawing(held: boolean): void {
    this.textPreviews.hold(held);
  }

  /** 3d.1b: the held text drawing ends now, and the next one starts (and waits again while held). */
  releaseTextDrawing(): void {
    this.textPreviews.release();
  }

  /** 3d.1b: the PNG the mock serves for a text preview id, or null for an id it never gave or has evicted: the dev build's stand-in for `studio-media://text/<previewId>`. */
  mockPreviewPng(previewId: string): Uint8Array | null {
    return this.textPreviews.picture(previewId);
  }

  setEncryptionAvailable(available: boolean): void {
    this.encryptionAvailable = available;
    this.settings = { ...this.settings, apiKey: { ...this.settings.apiKey, encryptionAvailable: available } };
  }

  /** Paid calls stop until a reconcile; announced with `money.reconcileNeeded`. */
  requireReconcile(reasons: ReconcileReason[]): void {
    this.reconcileReasons = [...new Set([...this.reconcileReasons, ...reasons])];
    this.emitReconcileNeeded();
  }

  /** A settle came in above its reserve: paid calls halt until a reconcile. */
  haltAboveWorst(): void {
    this.halt = { cause: "SETTLE_ABOVE_WORST", detail: "a mock settle above its worst case", attemptIds: [MOCK_ABOVE_WORST_ATTEMPT] };
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "engine.error", payload: { error: { code: "SETTLE_ABOVE_WORST" } } });
    this.emitMoney();
  }

  /** The next `money.reconcile` answers with `result` (a queue; the default is a matching `done`). */
  queueReconcile(result: ReconcileResult): void {
    this.reconcileQueue.push(result);
  }

  /** The next avatars.pickImportPhoto answers with `result` (e.g. `{ picked: false }`, a cancel) instead of a fresh staged photo. */
  queueImportPick(result: ImportPhotoPicked): void {
    this.nextImportPick = result;
  }

  /** The next avatars.importAvatar's one-time image age check fails: nothing is stored, the reserve is settled, AGE_CHECK_FAILED. */
  failNextImportAgeCheck(): void {
    this.nextImportAgeCheckFails = true;
  }

  /**
   * T6c review round 3, L4: the next avatars.importAvatar fails with `error`
   * only after its stage is already consumed (money already spent for the
   * age check) — unlike `failNext`, which answers before the gates even run
   * and so never touches the stage at all. Stands in for anything the real
   * engine's own paid job can fail with once the stage is gone (NETWORK,
   * INTERNAL, IMPORT_SUBJECT_INVALID, …), so a renderer test can tell that
   * case apart from a gate refusal that leaves the stage live.
   */
  failNextImportAfterConsuming(error: EngineError): void {
    this.nextImportFailure = error;
  }

  /** The next candidate job loses `count` portraits to the age check. */
  rejectNextByAgeCheck(count: number): void {
    this.ageRejectionsNextJob = Math.max(0, Math.min(CANDIDATES_PER_JOB, count));
  }

  /**
   * The next avatars.createDraft answers with a Draft whose `estimate` is
   * null, as if the engine could not price the next batch when it built the
   * draft — `Draft.estimate` is nullable in the contract (state.ts). Exercises
   * the renderer's avatars.estimateCandidates fallback for that case.
   */
  dropNextDraftEstimate(): void {
    this.nextDraftEstimateMissing = true;
  }

  /**
   * The next candidate job's trailing `count` slots (right before any
   * age-rejected tail from `rejectNextByAgeCheck`) fail with `error` instead
   * of producing a candidate — a moderation refusal, a timeout, and so on.
   * With `count` at 4 (and no age rejections), every slot fails: the batch
   * still ends `status: "done"`, just with zero candidates.
   */
  failNextSlots(count: number, error: EngineError, reserveLeftOpen = false): void {
    this.failedSlotsNextJob = { count: Math.max(0, Math.min(CANDIDATES_PER_JOB, count)), error, reserveLeftOpen };
  }

  /**
   * Closes or reopens the library, as a moved or unreadable folder does:
   * runs.start, runs.resume and runs.estimateResume answer LIBRARY_UNAVAILABLE
   * (after the key and the ledger), runs.estimate and photos.list cannot find
   * anything (NOT_FOUND), runs.list has no runs — the real engine's answers.
   */
  setLibraryAvailable(available: boolean): void {
    this.libraryOpen = available;
  }

  /**
   * No face gate wired into photo runs (the models or onnxruntime-web failed
   * to load at engine start): runs.start and runs.resume answer
   * FACE_GATE_UNAVAILABLE for free. `loadError` rides along in the detail, as
   * the engine's `faceGateLoadError` does.
   */
  setFaceGateAvailable(available: boolean, loadError?: string): void {
    this.faceGate = { available, ...(loadError === undefined ? {} : { loadError }) };
  }

  /** No age gate wired in: a run with the image age check on is refused AGE_GATE_UNAVAILABLE; with it off the gate is not in its path. */
  setAgeGateAvailable(available: boolean): void {
    this.ageGateAvailable = available;
  }

  /** The avatar's master photo is gone from the library: runs.start answers NOT_FOUND up front; a resume starts and its job fails NOT_FOUND. */
  removeMaster(avatarId: string): void {
    this.mastersMissing.add(avatarId);
  }

  /**
   * The gates' own look at the master before a run is planned fails for this
   * avatar (`MASTER_FACE_UNUSABLE`: no usable face; `INTERNAL`: the gates
   * could not be prepared): runs.start refuses it free, after the price
   * checks and before any run exists, as the engine does. `null` clears it.
   */
  setMasterPreflightFailure(avatarId: string, error: EngineError | null): void {
    if (error === null) this.masterPreflight.delete(avatarId);
    else this.masterPreflight.set(avatarId, error);
  }

  /**
   * The face gate that judges the focus of a placed photo is missing (its models did not load): every focus the montage commands
   * resolve is `null`, and the draft stores null, as the real engine's resolver answers when it cannot judge.
   */
  setFocusAvailable(available: boolean): void {
    this.focusAvailable = available;
  }

  /** `count` draft files could not be read: `montages.list` reports them as `skippedTotal` and leaves them out, never fails. */
  setSkippedDrafts(count: number): void {
    this.skippedDrafts = Math.max(0, count);
  }

  /**
   * The export folder's state on the disk (a drive unplugged, a folder removed). Nothing is announced: like the real engine, the
   * mock learns of it at its next check (a render attempt, `videos.list`, `videos.delete`) and only then tells the windows.
   */
  setExportDisk(status: ExportStatus): void {
    this.exportDisk = status;
  }

  /** Free space in the export folder: a render whose upper size estimate needs twice this much is refused `not-enough-space` (for that render only; the status stays `ok`). `null`: plenty. */
  setExportFreeBytes(bytes: number | null): void {
    this.exportFreeBytes = bytes;
  }

  /** How many renders may be queued or running together before `videos.render` answers RENDER_QUEUE_FULL; the real queue's is 20. */
  setRenderQueueLimit(limit: number): void {
    this.renderQueueLimit = limit;
  }

  /** What a check of this video's file finds from now on (`missing`, `changed`, `elsewhere`); `null` restores `present`. */
  setVideoFileState(videoId: string, state: FileState | null): void {
    this.videos = this.videos.map((v) => (v.summary.videoId === videoId ? { ...v, fileState: state } : v));
  }

  /**
   * The next render fails with `error`: no video, and its photos leave the reservation. `encode` (the default) is ffmpeg failing at the
   * job's first step, before any progress or saving phase; `saving` is the commit failing after the point of no return (the window
   * has seen the saving step). `late` (3e.2) is the engine's commit that outlived its deadline: the job reports failed at the saving
   * step, and one step later its record lands anyway (`video.changed` after `job.failed`, which the window shows as the video).
   */
  failNextRender(error: EngineError, at: "encode" | "saving" | "late" = "encode"): void {
    this.nextRenderFailure = { error, at };
  }

  /** The owner chose another export folder: every video made so far is in the old one (`elsewhere`), and the new folder is empty. */
  moveExportFolder(): void {
    this.exportRootId = this.newExportRootId();
  }

  /**
   * What main's folder dialog answers the next `settings.setExportPath`: the folder picked, or `null` for a cancel. Used once; with
   * nothing scripted the dialog picks a new folder of its own, so the dev mock shows a switch. `refuse` is the reason the engine's
   * check gives that folder, `movedFrom` says the folder is the one that stood at that path before (same marker, new place).
   */
  pickExportFolderNext(pick: MockExportPick | null): void {
    this.exportPick = pick;
  }

  /**
   * What main's own-media dialog answers the next `media.pickImport`: the files picked (each by display name, with the boundary's verdict),
   * or `null` for a cancel. Used once; with nothing scripted the dialog is cancelled.
   */
  pickMediaNext(pick: readonly MockMediaPick[] | null): void {
    this.mediaPick = pick;
  }

  /** 3f.1b: while held, an import job that starts waits (the engine's copy waits before its first byte); `false` lets every held job go on. */
  holdImports(held: boolean): void {
    this.ownMedia.hold(held);
  }

  private newExportRootId(): string {
    return `root-mock-${String(++this.exportRootsMade).padStart(4, "0")}`;
  }

  private get exportFiles(): Set<string> {
    let files = this.exportFilesByRoot.get(this.exportRootId);
    if (files === undefined) {
      files = new Set();
      this.exportFilesByRoot.set(this.exportRootId, files);
    }
    return files;
  }

  /** Undoes `removeMaster`. */
  restoreMaster(avatarId: string): void {
    this.mastersMissing.delete(avatarId);
  }

  /** T8b: changes one image attempt's price, so a run accepted at a lower worst case gets PRICE_CHANGED. */
  setRunImagePrice(micros: number): void {
    this.runImagePrice = micros;
  }

  /** The next run job's trailing `count` open slots end without a photo (their attempts all failed). */
  failNextRunSlots(count: number): void {
    this.failedRunSlotsNext = Math.max(0, count);
  }

  /**
   * A run stopped earlier, as `runs.list` would find it after a restart: its
   * first `done` slots already have their photos, the rest are open (so it is
   * resumable while any are). No events, and its own ids (`run-seed-…`,
   * `photo-seed-…`) and dates, so seeding never shifts the ids or times the
   * mock hands out afterwards. `capMicros`, when given, overrides the run's
   * own worst-case cap (L6: lets a test seed a run whose cap the already-
   * settled slots have used up, without needing a real run to actually
   * exhaust it slot by slot). Answers the run's id.
   */
  seedRun(request: RunRequest, done: number, capMicros?: number, opts: { writerDone?: boolean } = {}): string {
    this.seedCounter += 1;
    const n = String(this.seedCounter).padStart(4, "0");
    const runId = `run-seed-${n}`;
    const createdAt = new Date(START_OF_TIME - this.seedCounter * 3_600_000).toISOString();
    const slots = mockRunSlots(request.count, request.categories);
    const run: MockRun = {
      runId,
      avatarId: request.avatarId,
      createdAt,
      request,
      capMicros: capMicros ?? this.runPrice(request).worstMicros,
      settledMicros: 0,
      ageCheck: this.settings.imageAgeCheck === "on",
      slots,
      photoIds: [],
      writerDone: opts.writerDone ?? done > 0,
    };
    const { expected } = this.slotPrice(run);
    slots.slice(0, Math.min(done, slots.length)).forEach((slot, i) => {
      slot.end = "done";
      const photoId = `photo-seed-${n}-${String(i + 1).padStart(3, "0")}`;
      run.photoIds.push(photoId);
      run.settledMicros += expected;
      const qa = mockFaceQa(i);
      const at = new Date(Date.parse(createdAt) + (i + 1) * 60_000).toISOString();
      this.photos.push({ photoId, avatarId: request.avatarId, runId, category: slot.category, createdAt: at, used: false, usedIn: [], rejected: false, reserved: false, eligible: true, ...(qa ? { qa } : {}) });
    });
    this.photos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.runs = [...this.runs, run];
    return runId;
  }

  /** While off, events go into the log but are not delivered: the window misses them. */
  setDelivery(on: boolean): void {
    this.delivering = on;
  }

  /** Adds an avatar without any event, as if another window had saved it. */
  addAvatarSilently(avatar: AvatarSummary): void {
    this.avatars = [...this.avatars, avatar];
  }

  /**
   * Replaces the whole avatars list without any event, as a library switch's
   * new folder would — pair with `settings.setLibraryPath` (which bumps
   * `librarySwitchGeneration` and emits `settings.changed`) so the store's
   * own resync picks it up through a real snapshot, the way a genuine
   * library switch would (L11/LOW-9 tests: an avatar this window had pinned
   * can be entirely absent from the new list).
   */
  setAvatarsForNextSnapshot(avatars: AvatarSummary[]): void {
    this.avatars = avatars;
  }

  /**
   * Lists `entry` in `unreadableAvatars`, as the real engine would for a
   * quarantined manifest or a record the contract refuses. With `recoverTo`,
   * `avatars.rewriteDescriptor` can turn it into a normal draft or saved
   * avatar with that shape (its descriptor freshly written); without one, a
   * rewrite attempt on this id answers VALIDATION, like any other entry whose
   * reason is not `descriptor-invalid`.
   */
  seedUnreadable(entry: UnreadableAvatar, recoverTo?: RewriteTarget): void {
    this.unreadable = [...this.unreadable, entry];
    if (recoverTo !== undefined && entry.avatarId !== null) this.rewritable.set(entry.avatarId, recoverTo);
  }

  /** The engine process restarts: a new bootId, seq from 1, running jobs are gone, open reserves need a reconcile. */
  restart(): void {
    for (const job of [...this.jobs, ...this.runJobs]) {
      for (const cancel of job.cancelTimers) cancel();
      if (job.status === "queued" || job.status === "running") job.status = "cancelled";
    }
    // The renders of the old process are gone with their reservations; the videos and the drafts are on disk and stay.
    for (const job of this.renderJobs.filter(isActive)) {
      for (const cancel of job.timers) cancel();
      this.movingUsage(job.avatarId, job.photoIds, () => void (job.status = "cancelled"));
    }
    this.renderJobs = [];
    this.ownMedia.restart();
    this.boot += 1;
    this.log = new EventLog(this.capacity, this.bootId());
    if (this.reserves.size > 0 && !this.reconcileReasons.includes("open-reserves")) {
      this.reconcileReasons = [...this.reconcileReasons, "open-reserves"];
    }
    this.emitMoney();
  }

  /** Emits a `money.changed` with the current status (used to create seq traffic in tests). */
  touchMoney(): void {
    this.emitMoney();
  }

  /** Emits an `engine.notice` (a restart, a settings reset) for tests of the renderer's notice handling. */
  emitNotice(notice: EngineNotice): void {
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "engine.notice", payload: { notice } });
  }

  get currentBootId(): string {
    return this.log.bootId;
  }

  // ---------- command handling ----------

  /** A failure a test forced for this command (`failNext`), consumed. */
  private forcedFailure(c: CommandMessage): ResponseMessage | null {
    const forced = this.forced.get(c.type)?.shift();
    return forced === undefined ? null : this.fail(c, forced);
  }

  private handle(c: CommandMessage): ResponseMessage {
    const forced = this.forcedFailure(c);
    if (forced) return forced;

    switch (c.type) {
      case "settings.get":
        return this.ok(c, this.settings);
      case "settings.setApiKey": {
        if (!this.encryptionAvailable) return this.fail(c, { code: "ENCRYPTION_UNAVAILABLE" });
        const apiKey: ApiKeyStatus = { stored: true, last4: c.payload.key.slice(-4), encryptionAvailable: true, rejected: false };
        this.settings = { ...this.settings, apiKey };
        this.emitSettingsChanged();
        return this.ok(c, apiKey);
      }
      case "settings.clearApiKey": {
        const apiKey: ApiKeyStatus = { stored: false, last4: null, encryptionAvailable: this.encryptionAvailable, rejected: false };
        this.settings = { ...this.settings, apiKey };
        this.emitSettingsChanged();
        return this.ok(c, apiKey);
      }
      case "settings.setMusicKey": {
        if (!this.encryptionAvailable) return this.fail(c, { code: "ENCRYPTION_UNAVAILABLE" });
        const musicKey: MusicKeyStatus = { stored: true, last4: c.payload.key.slice(-4), rejected: false };
        this.settings = { ...this.settings, musicKey };
        this.emitSettingsChanged();
        return this.ok(c, musicKey);
      }
      case "settings.clearMusicKey": {
        const musicKey: MusicKeyStatus = { stored: false, last4: null, rejected: false };
        this.settings = { ...this.settings, musicKey };
        this.emitSettingsChanged();
        return this.ok(c, musicKey);
      }
      case "settings.setBudget":
        this.settings = { ...this.settings, monthlyBudgetMicros: c.payload.monthlyBudgetMicros };
        this.emitMoney();
        this.emitSettingsChanged();
        return this.ok(c, this.settings);
      case "settings.setLibraryPath":
        // A library switch is refused while any job, a render included, is queued or running.
        if (this.running().length > 0 || this.renderJobs.some(isActive) || this.ownMedia.active() > 0) return this.fail(c, { code: "IN_FLIGHT" });
        if (c.payload.path !== this.settings.libraryPath) this.librarySwitchGeneration += 1;
        this.settings = { ...this.settings, libraryPath: c.payload.path };
        this.emitSettingsChanged();
        return this.ok(c, this.settings);
      case "settings.setExportPath":
        return this.setExportPath(c);
      case "media.pickImport": {
        const pick = this.mediaPick;
        this.mediaPick = null;
        if (pick === null || pick.length === 0) return this.ok(c, { picked: false });
        // As main's flow does, file by file in the dialog's order: a refused file is listed by name and reason, an accepted one starts its job.
        const jobIds: string[] = [];
        const refused: { name: string; reason: MediaUnsupportedReason }[] = [];
        for (const file of pick) {
          if ("accept" in file) {
            const jobId = this.ownMedia.startImport(file.name, file.accept);
            if (jobId === null) refused.push({ name: file.name, reason: "too-many" });
            else jobIds.push(jobId);
          } else refused.push({ name: file.name, reason: file.reason });
        }
        return this.ok(c, { picked: true, jobIds, refused, skipped: 0 });
      }
      case "settings.exportDisplay":
        return this.ok(c, { display: displayPath(this.settings.exportPath) });
      case "stickers.bytes": {
        // Main's answer from the verified built-in set (3d.4 review round 1); the mock's is its own stand-in, the picture it shows.
        const bytes = mockStickerBytes(c.payload.stickerId);
        if (bytes === null) return this.fail(c, { code: "NOT_FOUND", detail: "no such built-in sticker" });
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return this.ok(c, { stickerId: c.payload.stickerId, apngBase64: btoa(binary) });
      }
      case "media.list":
        return this.ok(c, this.ownMedia.list(c.payload.kind));
      case "media.delete": {
        const { mediaId } = c.payload;
        if (!this.ownMedia.has(mediaId)) return this.fail(c, { code: "NOT_FOUND", detail: `no own media ${mediaId} in the open library` });
        // The engine asks the render queue's reserved set after it knows the media is there: a queued or running render that names it refuses.
        if (this.renderJobs.some((job) => isActive(job) && job.mediaIds.includes(mediaId))) return this.fail(c, { code: "IN_FLIGHT", detail: "a queued or running render uses this media; delete it when the render ends" });
        this.ownMedia.delete(mediaId);
        return this.ok(c, { mediaId });
      }
      case "media.cancelImport":
        if (!this.ownMedia.cancel(c.payload.jobId)) return this.fail(c, { code: "NOT_FOUND", detail: `no import job ${c.payload.jobId} in this engine` });
        return this.ok(c, { jobId: c.payload.jobId });
      case "export.check": {
        this.checkExport();
        return this.ok(c, { exportStatus: this.exportReported });
      }
      case "settings.setModels":
        this.settings = { ...this.settings, imageModel: c.payload.imageModel, textModel: c.payload.textModel };
        this.emitSettingsChanged();
        return this.ok(c, this.settings);
      case "settings.setConcurrency":
        this.settings = { ...this.settings, concurrency: { network: c.payload.network } };
        this.emitSettingsChanged();
        return this.ok(c, this.settings);
      case "settings.setImageAgeCheck":
        this.settings = { ...this.settings, imageAgeCheck: c.payload.imageAgeCheck };
        this.emitSettingsChanged();
        return this.ok(c, this.settings);
      case "money.status":
        return this.ok(c, this.moneyStatus());
      case "money.reconcile":
        return this.reconcile(c);
      case "avatars.list":
        return this.ok(c, { avatars: this.avatars, unreadableAvatars: this.unreadable, unreadableTotal: this.unreadableCount() });
      case "avatars.estimate":
        return this.ok(c, this.currentPrice());
      case "avatars.estimateCandidates": {
        const draft = this.drafts.find((d) => d.avatarId === c.payload.avatarId);
        if (!draft) return this.fail(c, { code: "NOT_FOUND" });
        if (!AvatarDescriptor.safeParse(draft.descriptor).success) return this.fail(c, { code: "DESCRIPTOR_INVALID" });
        return this.ok(c, this.candidatesPrice());
      }
      case "avatars.estimateRewriteDescriptor": {
        const refusal = this.rewriteRefusal(c.payload.avatarId);
        if (refusal) return this.fail(c, refusal);
        return this.ok(c, this.rewritePrice());
      }
      case "avatars.createDraft": {
        const refusal = this.paidGate(c.payload.acceptedWorstMicros, this.currentPrice().worstMicros);
        if (refusal) return this.fail(c, refusal);
        const noEstimate = this.nextDraftEstimateMissing;
        this.nextDraftEstimateMissing = false;
        const draft: Draft = {
          avatarId: this.nextId("avatar"),
          traits: c.payload.traits,
          descriptor: mockDescriptor(c.payload.traits),
          candidates: [],
          hiddenBelowThreshold: 0,
          // A draft's estimate is its next batch: the descriptor is already
          // paid for. null (dropNextDraftEstimate) mirrors the contract's
          // nullable case: the engine could not price the batch when it
          // built the draft.
          estimate: noEstimate ? null : this.candidatesPrice(),
        };
        this.drafts = [...this.drafts, draft];
        this.spend(DESCRIPTOR.expected);
        return this.ok(c, { draft });
      }
      case "avatars.generateCandidates": {
        const draft = this.drafts.find((d) => d.avatarId === c.payload.avatarId);
        if (!draft) return this.fail(c, { code: "NOT_FOUND" });
        if (this.jobRunningFor(draft.avatarId)) return this.fail(c, { code: "IN_FLIGHT" });
        if (!AvatarDescriptor.safeParse(draft.descriptor).success) return this.fail(c, { code: "DESCRIPTOR_INVALID" });
        // Another batch is priced without the descriptor, like avatars.estimateCandidates.
        const refusal = this.paidGate(c.payload.acceptedWorstMicros, this.candidatesPrice().worstMicros);
        if (refusal) return this.fail(c, refusal);
        return this.ok(c, { jobId: this.startJob(draft.avatarId) });
      }
      case "avatars.cancel": {
        const job = this.jobs.find((j) => j.jobId === c.payload.jobId);
        if (!job) return this.fail(c, { code: "NOT_FOUND" });
        if (job.status === "queued" || job.status === "running") {
          // No more slots are drawn from here on, but the job itself is not
          // cancelled yet: like the real engine (engine.ts's avatars.cancel
          // answers immediately, #runCandidates settles later), the status
          // flip and job.cancelled land on a later, separate tick.
          for (const cancel of job.cancelTimers) cancel();
          job.cancelTimers = [
            this.scheduler.schedule(CANCEL_CONFIRM_DELAY_MS, () => {
              // An aborted attempt counts at its worst case until reconciled: the reserve stays open.
              job.status = "cancelled";
              job.cancelTimers = [];
              this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "job.cancelled", payload: { kind: "avatar.candidates", jobId: job.jobId, avatarId: job.avatarId } });
            }),
          ];
        }
        return this.ok(c, { jobId: job.jobId });
      }
      case "avatars.pick": {
        const draft = this.drafts.find((d) => d.avatarId === c.payload.avatarId);
        if (!draft || !draft.candidates.some((cand) => cand.photoId === c.payload.photoId)) {
          return this.fail(c, { code: "NOT_FOUND" });
        }
        if (this.jobRunningFor(draft.avatarId)) return this.fail(c, { code: "IN_FLIGHT" });
        if (!AvatarDescriptor.safeParse(draft.descriptor).success) return this.fail(c, { code: "DESCRIPTOR_INVALID" });
        const avatar: AvatarSummary = {
          avatarId: draft.avatarId,
          name: c.payload.name.trim(),
          descriptor: draft.descriptor,
          masterPhotoId: c.payload.photoId,
          createdAt: this.nowIso(),
          status: "active",
          photoCount: 0,
          videoCount: 0,
          eligibleUnusedCount: 0,
          usage: { state: "ok" },
        };
        this.drafts = this.drafts.filter((d) => d !== draft);
        this.avatars = [...this.avatars, avatar];
        this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "avatar.changed", payload: { avatar } });
        return this.ok(c, { avatar });
      }
      case "avatars.archive": {
        const avatar = this.avatars.find((a) => a.avatarId === c.payload.avatarId);
        if (!avatar) return this.fail(c, { code: "NOT_FOUND" });
        if (!AvatarDescriptor.safeParse(avatar.descriptor).success) return this.fail(c, { code: "DESCRIPTOR_INVALID" });
        const archived: AvatarSummary = { ...avatar, status: "archived" };
        this.avatars = this.avatars.map((a) => (a === avatar ? archived : a));
        this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "avatar.changed", payload: { avatar: archived } });
        return this.ok(c, { avatar: archived });
      }
      case "avatars.rewriteDescriptor": {
        const { avatarId } = c.payload;
        // The engine's order: the key and the ledger before it even looks up
        // the id, then the id (NOT_FOUND/VALIDATION), then the price.
        const refusal = this.keyAndLedgerGate() ?? this.rewriteRefusal(avatarId) ?? this.priceGate(c.payload.acceptedWorstMicros, this.rewritePrice().worstMicros);
        if (refusal) return this.fail(c, refusal);
        const target = this.rewritable.get(avatarId);
        if (target === undefined) throw new Error("unreachable: rewriteRefusal already checked the target exists");
        this.applyRewrite(avatarId, target);
        this.spend(DESCRIPTOR.expected);
        return this.ok(c, { avatarId });
      }
      case "avatars.pickImportPhoto": {
        if (this.nextImportPick !== null) {
          const queued = this.nextImportPick;
          this.nextImportPick = null;
          return this.ok(c, queued);
        }
        const stagingId = this.nextId("staging");
        this.stagedImportId = stagingId;
        return this.ok(c, { picked: true, stagingId, width: 1024, height: 1365 });
      }
      case "avatars.estimateImport": {
        if (c.payload.stagingId !== this.stagedImportId) return this.fail(c, { code: "NOT_FOUND", detail: "no staged photo; pick one again" });
        return this.ok(c, this.importPrice());
      }
      case "avatars.importAvatar": {
        // The engine's order: the key and the ledger before the id, then the
        // id, then the price — mirroring avatars.rewriteDescriptor's own gate order above.
        const gate = this.keyAndLedgerGate() ?? (c.payload.stagingId === this.stagedImportId ? null : { code: "NOT_FOUND" as const, detail: "no staged photo; pick one again" });
        if (gate) return this.fail(c, gate);
        const priced = this.priceGate(c.payload.acceptedWorstMicros, this.importPrice().worstMicros);
        if (priced) return this.fail(c, priced);
        // Single-use, consumed now: only if this is still the same staged
        // photo — a later stage that replaced it during the checks above
        // must survive (L1's own real-engine guard, mirrored here).
        if (this.stagedImportId === c.payload.stagingId) this.stagedImportId = null;
        if (this.nextImportFailure) {
          const error = this.nextImportFailure;
          this.nextImportFailure = null;
          this.spend(IMPORT_FALLBACK_PRICE.ageCheck.expectedMicros);
          return this.fail(c, error);
        }
        if (this.nextImportAgeCheckFails) {
          this.nextImportAgeCheckFails = false;
          // The one-time age check ran (and is billed) before the describe
          // call would have; nothing else is spent, nothing is stored. L8:
          // the age check's own expected micros, shared with plan.test.ts
          // and the import tile's own text — never a separate number.
          this.spend(IMPORT_FALLBACK_PRICE.ageCheck.expectedMicros);
          return this.fail(c, { code: "AGE_CHECK_FAILED" });
        }
        const avatar: AvatarSummary = {
          avatarId: this.nextId("avatar"),
          name: c.payload.name.trim(),
          descriptor: mockDescriptor(MOCK_IMPORT_TRAITS),
          masterPhotoId: this.nextId("photo"),
          createdAt: this.nowIso(),
          status: "active",
          photoCount: 0,
          videoCount: 0,
          eligibleUnusedCount: 0,
          usage: { state: "ok" },
        };
        this.avatars = [...this.avatars, avatar];
        this.spend(this.importPrice().expectedMicros);
        this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "avatar.changed", payload: { avatar } });
        return this.ok(c, { avatar });
      }
      case "photos.list": {
        const { avatarId } = c.payload;
        // NOT_FOUND only for an id the library does not have at all: a draft, an active and an archived avatar all get their list.
        const known = this.libraryOpen && (this.avatars.some((a) => a.avatarId === avatarId) || this.drafts.some((d) => d.avatarId === avatarId));
        if (!known) return this.fail(c, { code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
        const photos = this.photos.filter((p) => p.avatarId === avatarId).reverse().slice(0, MAX_LISTED_PHOTOS).map((p) => this.photoView(p));
        return this.ok(c, { photos, skippedTotal: this.skippedPhotos[avatarId] ?? 0 });
      }
      case "runs.list":
        // L7: an unavailable ledger answers no runs at all, like the real
        // engine's own #listRuns (it needs the ledger for every run's own
        // committed/remaining figures, not just the list itself).
        if (this.unavailable !== null || !this.libraryOpen) return this.ok(c, { runs: [] });
        return this.ok(c, { runs: this.sortedRuns().slice(0, MAX_LISTED_RUNS).map((r) => this.runSummary(r)) });
      case "runs.estimate": {
        // No library open: the engine cannot find the avatar either.
        const refusal = this.libraryOpen ? this.runnableRefusal(c.payload.avatarId) : { code: "NOT_FOUND" as const, detail: `no saved, active avatar ${c.payload.avatarId} in the open library` };
        if (refusal) return this.fail(c, refusal);
        return this.ok(c, { estimate: this.runPrice(c.payload) });
      }
      case "runs.start": {
        const { acceptedWorstMicros, ...request } = c.payload;
        // The engine's order: the avatar is claimed first, then the key and the ledger, the avatar itself, and the price.
        if (this.jobRunningFor(request.avatarId)) return this.fail(c, { code: "IN_FLIGHT", detail: "a photo run or another job is already changing this avatar" });
        // Then, in the engine's own order: the library, the avatar, its master, the age gate (only when the check is on), the face gate, the price.
        const refusal =
          this.keyAndLedgerGate() ??
          this.libraryGate() ??
          this.runnableRefusal(request.avatarId) ??
          this.masterRefusal(request.avatarId) ??
          this.gateRefusal(this.settings.imageAgeCheck === "on") ??
          this.priceGate(acceptedWorstMicros, this.runPrice(request).worstMicros) ??
          (this.masterPreflight.get(request.avatarId) ?? null);
        if (refusal) return this.fail(c, refusal);
        const run: MockRun = {
          runId: this.nextId("run"),
          avatarId: request.avatarId,
          createdAt: this.nowIso(),
          request,
          capMicros: this.runPrice(request).worstMicros,
          settledMicros: 0,
          ageCheck: this.settings.imageAgeCheck === "on",
          slots: mockRunSlots(request.count, request.categories),
          photoIds: [],
          writerDone: false,
        };
        this.runs = [...this.runs, run];
        return this.ok(c, { runId: run.runId, jobId: this.startRunJob(run) });
      }
      case "runs.cancel": {
        const run = this.runs.find((r) => r.runId === c.payload.runId);
        if (!run) return this.fail(c, { code: "NOT_FOUND", detail: `no run ${c.payload.runId}` });
        const job = this.activeRunJob(run.runId);
        if (job) this.cancelRunJob(job);
        return this.ok(c, { runId: run.runId });
      }
      case "runs.estimateResume": {
        // The engine's order: the library, then the run's own plan, then (in #remaining) the ledger, VALIDATION and the cap.
        const gone = this.libraryGate();
        if (gone) return this.fail(c, gone);
        const run = this.runs.find((r) => r.runId === c.payload.runId);
        if (!run) return this.fail(c, { code: "NOT_FOUND", detail: `no run ${c.payload.runId}` });
        const stopped = this.unavailable === null ? null : { code: this.unavailable.cause, detail: this.unavailable.detail };
        if (stopped) return this.fail(c, stopped);
        // L7: matches the real engine's own #remaining, which runs.resume already shares with this command.
        if (run.slots.every((s) => s.end !== null)) return this.fail(c, { code: "VALIDATION", detail: `run ${run.runId} has nothing left to resume: every slot already ended` });
        if (this.capExhausted(run)) return this.fail(c, this.capEndedError(run));
        return this.ok(c, { estimate: this.resumePrice(run) });
      }
      case "runs.resume": {
        // The engine's order: a run already running is IN_FLIGHT before anything else; then the key, the ledger, the
        // library, the run's own plan (NOT_FOUND), the avatar claimed by another job (IN_FLIGHT), the avatar itself,
        // the run's own age gate (the mode it started with) and the face gate, VALIDATION, the cap, and the price.
        // No master check: the engine only finds a missing master when the job loads it.
        const run = this.runs.find((r) => r.runId === c.payload.runId);
        if (run && this.activeRunJob(run.runId)) return this.fail(c, { code: "IN_FLIGHT", detail: `run ${run.runId} is already running` });
        const early = this.keyAndLedgerGate() ?? this.libraryGate() ?? (run ? null : { code: "NOT_FOUND" as const, detail: `no run ${c.payload.runId}` });
        if (early || !run) return this.fail(c, early ?? { code: "NOT_FOUND", detail: `no run ${c.payload.runId}` });
        const refusal =
          (this.jobRunningFor(run.avatarId) ? { code: "IN_FLIGHT" as const } : null) ??
          this.runnableRefusal(run.avatarId) ??
          this.gateRefusal(run.ageCheck) ??
          (run.slots.every((s) => s.end !== null) ? { code: "VALIDATION" as const, detail: "every slot of this run already ended" } : null) ??
          (this.capExhausted(run) ? this.capEndedError(run) : null) ??
          // A free resume (worst 0) spends nothing: the accepted price still counts, a month already over budget does not.
          this.priceGate(c.payload.acceptedWorstMicros, this.resumePrice(run).worstMicros, { freeIsAlwaysFine: true });
        if (refusal) return this.fail(c, refusal);
        return this.ok(c, { runId: run.runId, jobId: this.startRunJob(run) });
      }
      case "videos.render":
        return this.videosRender(c, c.payload);
      case "videos.cancel":
        return this.videosCancel(c, c.payload.jobId);
      case "videos.list":
        return this.videosList(c, c.payload.avatarId);
      case "videos.delete":
        return this.videosDelete(c, c.payload);
      case "videos.reveal":
        return this.videosReveal(c, c.payload.videoId);
      case "videos.revealFolder":
        return this.videosRevealFolder(c, c.payload.avatarId);
      case "videos.get":
        return this.videosGet(c, c.payload.videoId);
      case "videos.quarantineRecords":
        return this.clearUsageReason(c, c.payload.avatarId, "record-unreadable", (cleared) => ({ quarantined: cleared ? 1 : 0 }));
      case "photos.rebuildRejected": {
        const { avatarId } = c.payload;
        const kept = this.photos.filter((p) => p.avatarId === avatarId && p.rejected).length;
        return this.clearUsageReason(c, avatarId, "rejects-unreadable", (cleared) => ({ rebuilt: cleared, kept, dropped: cleared ? 1 : 0 }));
      }
      case "music.status":
        return this.ok(c, this.musicStatus());
      case "music.refresh":
        return this.musicRefresh(c);
      case "music.recoverQuotaLog":
        return this.musicRecover(c);
      case "music.list":
        return this.ok(c, { tracks: listedTracks(this.music.tracks) });
      case "music.peaks":
        return this.musicPeaks(c, c.payload);
      case "montages.textPreview":
        // Answered by `request`, which waits for the worker's lane; `handle` is never given it.
        return this.fail(c, { code: "INTERNAL", detail: `${c.type} is answered by the lane` });
      case "montages.create":
        return this.montagesCreate(c, c.payload);
      case "montages.get":
        return this.montagesGet(c, c.payload.montageId);
      case "montages.list":
        return this.montagesList(c, c.payload.avatarId);
      case "montages.save":
        return this.montagesSave(c, c.payload);
      case "montages.delete":
        return this.montagesDelete(c, c.payload.montageId);
      case "montages.focus":
        return this.montagesFocus(c, c.payload);
      case "photos.setRejected": {
        // The real engine's behaviour (task 3a.2): the owner's mark is set or cleared, an already-set one changes nothing, and the avatar's eligibleUnusedCount follows (the mock's photos are never used or reserved).
        const { avatarId, photoId, rejected } = c.payload;
        const photo = this.libraryOpen ? this.photos.find((p) => p.photoId === photoId && p.avatarId === avatarId) : undefined;
        if (photo === undefined) return this.fail(c, { code: "NOT_FOUND", detail: `no scene photo ${photoId} of avatar ${avatarId} in the open library` });
        if (photo.rejected === rejected) return this.ok(c, { photo: this.photoView(photo) });
        const updated: PhotoSummary = { ...photo, rejected, eligible: !rejected };
        // A photo that is in a video or held by a render was not counted as eligible and unused, and is not now: the count moves only for a free one.
        const free = !this.photoView(photo).used && !this.photoView(photo).reserved;
        this.photos = this.photos.map((p) => (p === photo ? updated : p));
        this.shiftEligibleUnused(avatarId, free ? (rejected ? -1 : 1) : 0);
        return this.ok(c, { photo: this.photoView(updated) });
      }
      case "engine.snapshot":
        return this.ok(c, this.snapshot());
      case "engine.events":
        return this.ok(c, this.log.since(c.payload.afterSeq, c.payload.bootId));
    }
  }

  private ok(c: CommandMessage, result: unknown): ResponseMessage {
    // Parsed, not cast: a mock result that breaks the contract throws here.
    return OkResponse.parse({ v: PROTOCOL_VERSION, id: c.id, kind: "response", type: c.type, ok: true, result });
  }

  private fail(c: CommandMessage, error: EngineError): ResponseMessage {
    return { v: PROTOCOL_VERSION, id: c.id, kind: "response", type: c.type, ok: false, error };
  }

  /** A stop no reconcile lifts: the ledger could not be read, or a write failed. */
  private ledgerStop(): EngineError | null {
    if (this.unavailable !== null) return { code: this.unavailable.cause, detail: this.unavailable.detail };
    if (this.halt?.cause === "LEDGER_WRITE_FAILED") return { code: "LEDGER_WRITE_FAILED", detail: this.halt.detail };
    return null;
  }

  /** The key and the ledger: the engine's first checks before any paid call, before it even looks up what the command names. */
  private keyAndLedgerGate(): EngineError | null {
    const key = this.settings.apiKey;
    if (!key.stored) return { code: "AUTH_INVALID", detail: "no API key is stored" };
    if (key.rejected) return { code: "AUTH_INVALID" };
    const stopped = this.ledgerStop();
    if (stopped) return stopped;
    if (this.reconcileReasons.length > 0 || this.halt !== null) return { code: "RECONCILE_REQUIRED" };
    return null;
  }

  /** The price checks: after the command's target is found valid, `worstMicros` is this command's own worst case. */
  private priceGate(acceptedWorstMicros: number, worstMicros: number, options: { freeIsAlwaysFine?: boolean } = {}): EngineError | null {
    if (acceptedWorstMicros < worstMicros) return { code: "PRICE_CHANGED" };
    if (options.freeIsAlwaysFine === true && worstMicros === 0) return null;
    const committed = this.spentMicros + this.unsettledMicros() + worstMicros;
    if (committed > this.settings.monthlyBudgetMicros) return { code: "BUDGET_EXCEEDED" };
    return null;
  }

  /** The engine's checks before any paid call, in the order it runs them; `worstMicros` is this command's own worst case. */
  private paidGate(acceptedWorstMicros: number, worstMicros: number): EngineError | null {
    return this.keyAndLedgerGate() ?? this.priceGate(acceptedWorstMicros, worstMicros);
  }

  private reconcile(c: CommandMessage): ResponseMessage {
    const stopped = this.ledgerStop();
    if (stopped) return this.fail(c, stopped);
    if (this.running().length > 0) return this.fail(c, { code: "IN_FLIGHT" });
    const ledgerDelta = this.spentSinceReconcile + this.unsettledMicros();
    const result: ReconcileResult = this.reconcileQueue.shift() ?? {
      status: "done",
      creditsDeltaMicros: ledgerDelta,
      deltaUnavailable: null,
      ledgerDeltaMicros: ledgerDelta,
      mismatch: false,
      closedReserves: this.reserves.size,
      aboveWorstAttempts: this.halt?.cause === "SETTLE_ABOVE_WORST" ? this.halt.attemptIds : [],
      tornLineMoved: this.reconcileReasons.includes("torn-ledger-line"),
      warnings: [],
    };
    if (result.status === "done") {
      // Open reserves close at their worst case.
      this.spentMicros += this.unsettledMicros();
      this.reserves.clear();
      this.spentSinceReconcile = 0;
      this.reconcileReasons = [];
      this.halt = null;
      this.emitMoney();
    }
    return this.ok(c, result);
  }

  /** Whether an avatar has a candidate batch or a photo run still queued or running: a second batch, a pick or a run must wait. */
  private jobRunningFor(avatarId: string): boolean {
    const active = (j: { avatarId: string; status: JobState["status"] }): boolean => j.avatarId === avatarId && (j.status === "queued" || j.status === "running");
    return this.jobs.some(active) || this.runJobs.some(active);
  }

  // ---------- montage drafts (3d.1b) ----------
  //
  // The real engine's `MontageService`, over the mock's own data. The order of every refusal is the engine's: the library first
  // (every command asks for it), then the draft or the avatar, then what the command checks about them. Nothing here reads a pixel:
  // a photo's focus is `MOCK_FOCUS` when its face gate scored it and `null` when it did not.

  /** The photo as the windows see it: `used`, `usedIn` and `reserved` follow the mock's videos and queued or running renders, on top of what a seeded photo already says. */
  private photoView(photo: PhotoSummary): PhotoSummary {
    const usedIn = [...new Set([...photo.usedIn, ...this.videos.filter((v) => v.summary.avatarId === photo.avatarId && v.photoIds.includes(photo.photoId)).map((v) => v.summary.videoId)])];
    const reserved = photo.reserved || this.renderJobs.some((j) => isActive(j) && j.avatarId === photo.avatarId && j.photoIds.includes(photo.photoId));
    return { ...photo, used: usedIn.length > 0, usedIn, reserved };
  }

  /** The engine's `photoAvailability(...).usable`: an eligible scene photo of the avatar that is in no video and held by no render. */
  private photoUsable(avatarId: string, photoId: string): boolean {
    const photo = this.photos.find((p) => p.avatarId === avatarId && p.photoId === photoId);
    if (photo === undefined) return false;
    const view = this.photoView(photo);
    return view.eligible && !view.used && !view.reserved;
  }

  private avatarKnown(avatarId: string): boolean {
    return this.avatars.some((a) => a.avatarId === avatarId) || this.drafts.some((d) => d.avatarId === avatarId);
  }

  private activeAvatarRefusal(avatarId: string): EngineError | null {
    return this.avatars.some((a) => a.avatarId === avatarId && a.status === "active") ? null : { code: "NOT_FOUND", detail: `no active avatar ${avatarId} in the open library` };
  }

  private unknownDraft(montageId: string): EngineError {
    return { code: "NOT_FOUND", detail: `no montage draft ${montageId}` };
  }

  /** K11: a photo that is not an eligible, unused, unreserved scene photo of this avatar is refused, with its index in `photoIds`. */
  private photosRefusal(avatarId: string, photoIds: readonly string[]): EngineError | null {
    const issues: MontageIssue[] = [];
    photoIds.forEach((photoId, i) => {
      if (!this.photoUsable(avatarId, photoId)) issues.push({ code: "photo-unavailable", path: ["photoIds", i] });
    });
    return issues.length === 0 ? null : { code: "PHOTO_UNAVAILABLE", issues };
  }

  private focusOf(avatarId: string, photoId: string): Focus | null {
    if (!this.focusAvailable) return null;
    const photo = this.photos.find((p) => p.avatarId === avatarId && p.photoId === photoId);
    return photo?.qa?.faceCos === undefined ? null : { ...MOCK_FOCUS };
  }

  /** The engine's `draftIssues`: what a render refuses (structure, then the parts whose slice has not landed), then the referential issues, cut at 64. */
  private draftIssues(spec: MontageDraft): MontageIssue[] {
    const referential: MontageIssue[] = [];
    // Photos in clip order and cell order, each in its own words: a scene photo that is not usable, an own photo the library does not hold (3f.2).
    const judge = (photo: { source: "scene"; photoId: string } | { source: "own"; mediaId: string } | null | undefined, path: (string | number)[]): void => {
      if (photo?.source === "scene" && !this.photoUsable(spec.avatarId, photo.photoId)) referential.push({ code: "photo-unavailable", path });
      if (photo?.source === "own" && !this.ownMedia.holdsPhoto(photo.mediaId)) referential.push({ code: "media-unavailable", path });
    };
    spec.clips.forEach((clip, i) => {
      if (clip.kind === "photo") judge(clip.cell.photo, ["clips", i, "cell"]);
      else if (clip.kind === "collage") clip.cells.forEach((cell, j) => judge(cell.photo, ["clips", i, "cells", j]));
    });
    // The set is in the build: the engine's own function, so the mock and the engine name the same stickers.
    referential.push(...stickerIssues(spec));
    // The store's tracks are the mock's own: the engine's function judges a trending track against what is held.
    referential.push(...trackIssues(spec, (trackId) => storedTrack(this.music.tracks, trackId)));
    return [...montageIssues(spec, "spec"), ...notYetSupportedIssues(spec), ...referential].slice(0, MAX_MONTAGE_ISSUES);
  }

  private announceDraft(montage: Montage): void {
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "montage.changed", payload: { change: "upserted", montage } });
  }

  private montagesCreate(c: CommandMessage, payload: { avatarId: string; photoIds: string[] }): ResponseMessage {
    const { avatarId, photoIds } = payload;
    // The contract already refuses both; the real service checks them again for callers that did not go through it.
    if (photoIds.length > MAX_CLIPS) return this.fail(c, { code: "VALIDATION", detail: `at most ${MAX_CLIPS} photos, got ${photoIds.length}` });
    if (new Set(photoIds).size !== photoIds.length) return this.fail(c, { code: "VALIDATION", detail: "a photo can appear only once in a montage" });
    const refusal = this.libraryGate() ?? this.activeAvatarRefusal(avatarId) ?? this.photosRefusal(avatarId, photoIds);
    if (refusal) return this.fail(c, refusal);
    this.montageSeeds += 1;
    const seed = (this.montageSeeds * 2_654_435_761) % 4_294_967_296;
    const spec = withFocus(defaultSpec(avatarId, photoIds, seed), new Map(photoIds.map((photoId) => [photoId, this.focusOf(avatarId, photoId)])));
    const montage = Montage.parse({ montageId: this.nextId("montage"), name: null, spec, updatedAt: this.nowIso() });
    this.montages.set(montage.montageId, montage);
    this.announceDraft(montage);
    return this.ok(c, { montage });
  }

  private montagesGet(c: CommandMessage, montageId: string): ResponseMessage {
    const gone = this.libraryGate();
    if (gone) return this.fail(c, gone);
    const montage = this.montages.get(montageId);
    if (montage === undefined) return this.fail(c, this.unknownDraft(montageId));
    return this.ok(c, { montage, issues: this.draftIssues(montage.spec) });
  }

  private montagesList(c: CommandMessage, avatarId: string | undefined): ResponseMessage {
    const refusal = this.libraryGate() ?? (avatarId !== undefined && !this.avatarKnown(avatarId) ? { code: "NOT_FOUND" as const, detail: `no avatar ${avatarId} in the open library` } : null);
    if (refusal) return this.fail(c, refusal);
    const drafts = [...this.montages.values()]
      .filter((m) => avatarId === undefined || m.spec.avatarId === avatarId)
      // Newest first by the instant, as the engine's store sorts (never by the text of the stamp).
      .sort((a, b) => {
        const at = Date.parse(a.updatedAt);
        const bt = Date.parse(b.updatedAt);
        return at !== bt ? (at < bt ? 1 : -1) : a.montageId < b.montageId ? -1 : 1;
      });
    const items = drafts.slice(0, MAX_LISTED_MONTAGES).map((montage) => ({
      montage,
      issues: this.draftIssues(montage.spec),
      videoCount: this.videos.filter((v) => v.montageId === montage.montageId).length,
    }));
    return this.ok(c, { items, total: drafts.length, skippedTotal: this.skippedDrafts });
  }

  private montagesSave(c: CommandMessage, payload: { montageId: string; spec: MontageDraft; name: string | null }): ResponseMessage {
    const { montageId, spec, name } = payload;
    const gone = this.libraryGate();
    if (gone) return this.fail(c, gone);
    const stored = this.montages.get(montageId);
    if (stored === undefined) return this.fail(c, this.unknownDraft(montageId));
    if (spec.avatarId !== stored.spec.avatarId) return this.fail(c, { code: "VALIDATION", detail: "the spec belongs to another avatar than the draft" });
    // As the engine stamps a save (`nextStamp`): its clock's now, but always after the stamp it replaces; a stored
    // stamp that cannot be read gives way to now.
    const now = Date.parse(this.nowIso());
    const after = Date.parse(stored.updatedAt) + 1;
    const updatedAt = new Date(Number.isNaN(after) ? now : Math.max(now, after)).toISOString();
    const montage = Montage.parse({ montageId, name, spec, updatedAt });
    this.montages.set(montageId, montage);
    this.announceDraft(montage);
    return this.ok(c, { montage });
  }

  private montagesDelete(c: CommandMessage, montageId: string): ResponseMessage {
    const gone = this.libraryGate();
    if (gone) return this.fail(c, gone);
    const stored = this.montages.get(montageId);
    if (stored === undefined) return this.fail(c, this.unknownDraft(montageId));
    this.montages.delete(montageId);
    this.removedMontages.add(montageId);
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "montage.changed", payload: { change: "removed", montageId, avatarId: stored.spec.avatarId } });
    return this.ok(c, { montageId });
  }

  private montagesFocus(c: CommandMessage, payload: { avatarId: string; photo: { source: "scene"; photoId: string } | { source: "own"; mediaId: string } }): ResponseMessage {
    const { avatarId, photo } = payload;
    const refusal = this.libraryGate() ?? this.activeAvatarRefusal(avatarId);
    if (refusal) return this.fail(c, refusal);
    // 3f.2: an own photo must be one the library holds as a photo (NOT_FOUND otherwise: PHOTO_UNAVAILABLE lists scene photos only); its focus is
    // the face's point when the script says the detector would find one, and none when it would not.
    if (photo.source === "own") {
      if (!this.ownMedia.holdsPhoto(photo.mediaId)) return this.fail(c, { code: "NOT_FOUND", detail: `no own photo ${photo.mediaId} in the open library` });
      return this.ok(c, { focus: this.ownMedia.hasFace(photo.mediaId) ? { ...MOCK_FOCUS } : null });
    }
    const known = this.photos.find((p) => p.avatarId === avatarId && p.photoId === photo.photoId);
    if (known === undefined || !known.eligible) return this.fail(c, { code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["photo"] }] });
    return this.ok(c, { focus: this.focusOf(avatarId, photo.photoId) });
  }

  // ---------- videos and render jobs (3d.1b) ----------
  //
  // The real engine's `VideoService` and render queue, over the mock's own data. `videos.render` checks in the engine's order (the
  // draft, the spec, the export folder, the avatar, the photos, the queue) and only then reserves; the job is `queued` until a pool
  // slot frees, `running` through `MOCK_RENDER_STEPS` progress steps, `saving` (a cancel is ignored from there), and commits a
  // record before it ends. Every step announces itself in the order the engine's events come. The video is a record only: the
  // mock makes no file, and `bytes` is the montage's expected size.

  private renderPoolSize(): number {
    const setting = this.settings.renderConcurrency;
    return setting === "auto" ? 1 : setting;
  }

  /** Keeps the export folder's status and, when a check finds it CHANGED, tells the windows (`export.status`); the first look of an engine's life is the baseline the snapshot carries. */
  private setReportedExport(next: ExportStatus): void {
    const before = this.exportReported;
    this.exportReported = next;
    const same = before.status === next.status && (before.status === "ok" || (next.status === "unavailable" && before.reason === next.reason));
    if (!same) this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "export.status", payload: { exportStatus: next } });
  }

  /**
   * One check of the export folder, as the engine makes it at a render attempt, a listing and a delete. `requiredBytes` (a render's
   * upper size estimate) also asks for twice that free: not enough room refuses THAT render and is never the status every window shows.
   */
  private checkExport(requiredBytes?: number): ExportUnavailableReason | null {
    const disk = this.exportDisk;
    let reason: ExportUnavailableReason | null = disk.status === "unavailable" ? this.markerReason(disk.reason) : null;
    if (reason === null && requiredBytes !== undefined && this.exportFreeBytes !== null && this.exportFreeBytes < requiredBytes * 2) reason = "not-enough-space";
    if (requiredBytes === undefined || reason !== "not-enough-space") this.setReportedExport(reason === null ? { status: "ok" } : { status: "unavailable", reason });
    return reason;
  }

  /** Where a video's file stands, as the check that just ran found it: a folder that cannot be looked in reads `elsewhere`. */
  private fileStateOf(video: MockVideo): FileState {
    if (this.exportReported.status === "unavailable" || video.rootId !== this.exportRootId) return "elsewhere";
    return video.fileState ?? "present";
  }

  /** The engine tells a damaged marker apart once the library holds a video: the text then never advises deleting the file. */
  private markerReason(reason: ExportUnavailableReason): ExportUnavailableReason {
    return reason === "invalid-marker" && this.videos.length > 0 ? "invalid-marker-with-records" : reason;
  }

  /**
   * `settings.setExportPath`: main's dialog, then the engine's check of the pick, then main's save and `settings.update`. A
   * cancel changes nothing. The folder is identified by its marker: one the mock has seen keeps its identity (so the videos made
   * in it resolve again), a new one gets its own.
   */
  private setExportPath(c: CommandMessage): ResponseMessage {
    const pick = this.exportPick;
    this.exportPick = undefined;
    if (pick === null) return this.ok(c, { picked: false });
    if (this.renderJobs.some(isActive)) {
      return this.fail(c, { code: "IN_FLIGHT", detail: "a video render is queued or running; change the export folder when it ends" });
    }
    const path = pick?.path ?? `${MOCK_HOME}/Reels-${++this.unscriptedPicks}`;
    if (pick?.refuse !== undefined) {
      const exportReason = this.markerReason(pick.refuse);
      return this.fail(c, { code: "EXPORT_UNAVAILABLE", exportReason, detail: `the folder cannot be the export folder (${exportReason})` });
    }
    let rootId = this.exportFolders.get(path);
    if (rootId === undefined) {
      const moved = pick?.movedFrom === undefined ? undefined : this.exportFolders.get(pick.movedFrom);
      if (pick?.movedFrom !== undefined) this.exportFolders.delete(pick.movedFrom);
      rootId = moved ?? this.newExportRootId();
      this.exportFolders.set(path, rootId);
    }
    const resolved = this.videos.filter((v) => v.rootId === rootId).length;
    const elsewhere = this.videos.length - resolved;
    this.settings = { ...this.settings, exportPath: path };
    this.exportRootId = rootId;
    this.exportDisk = { status: "ok" };
    // The engine checks the folder again when it gets the settings, then announces them.
    this.checkExport();
    this.emitSettingsChanged();
    return this.ok(c, { picked: true, settings: this.settings, rootId, resolved, elsewhere, incomplete: pick?.incomplete === true });
  }

  private adjustAvatar(avatarId: string, delta: { videoCount?: number; eligibleUnused?: number }): void {
    this.avatars = this.avatars.map((a) =>
      a.avatarId === avatarId
        ? { ...a, videoCount: Math.max(0, a.videoCount + (delta.videoCount ?? 0)), eligibleUnusedCount: Math.max(0, a.eligibleUnusedCount + (delta.eligibleUnused ?? 0)) }
        : a,
    );
  }

  /** Tells the windows the avatar's counts moved (`avatar.changed`). */
  private announceAvatar(avatarId: string): void {
    const avatar = this.avatars.find((a) => a.avatarId === avatarId);
    if (avatar !== undefined) this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "avatar.changed", payload: { avatar } });
  }

  /** Runs `change`, then moves the avatar's eligibleUnusedCount by the photos it made usable or unusable (silently: the caller announces). */
  private movingUsage(avatarId: string, photoIds: readonly string[], change: () => void): void {
    const usable = (): number => photoIds.filter((photoId) => this.photoUsable(avatarId, photoId)).length;
    const before = usable();
    change();
    this.adjustAvatar(avatarId, { eligibleUnused: usable() - before });
  }

  private liveDraft(montageId: string | null): string | null {
    return montageId !== null && this.montages.has(montageId) ? montageId : null;
  }

  private videosRender(c: CommandMessage, payload: { montageId: string } | { spec: MontageDraft }): ResponseMessage {
    let montageId: string | null = null;
    let title: string | null = null;
    let spec: MontageDraft;
    if ("montageId" in payload) {
      // A saved draft is read first: a draft that is gone refuses before anything else is looked at.
      const gone = this.libraryGate();
      if (gone) return this.fail(c, gone);
      const draft = this.montages.get(payload.montageId);
      if (draft === undefined) return this.fail(c, this.unknownDraft(payload.montageId));
      montageId = draft.montageId;
      title = draft.name;
      spec = draft.spec;
    } else {
      spec = payload.spec;
    }
    // The engine's order (`videos.render`): structure, what has not landed (N9), the stickers the set lacks, the music track (judged
    // against the mock's own store, as `montages.get` does: a stored track renders).
    const issues = [...montageIssues(spec, "spec"), ...notYetSupportedIssues(spec), ...stickerIssues(spec), ...trackIssues(spec, (trackId) => storedTrack(this.music.tracks, trackId))].slice(
      0,
      MAX_MONTAGE_ISSUES,
    );
    if (issues.length > 0) return this.fail(c, { code: "MONTAGE_INVALID", issues });
    // 3f.2: then each own photo is looked up (and held) before the export folder is asked: one that is not there is `media-unavailable`
    // at each of its cells, through the same function the engine's admission uses.
    const missing = ownPhotoIssues(spec, (mediaId) => this.ownMedia.holdsPhoto(mediaId)).slice(0, MAX_MONTAGE_ISSUES);
    if (missing.length > 0) return this.fail(c, { code: "MONTAGE_INVALID", issues: missing });
    const reason = this.checkExport(estimateBytesUpper(spec.clips));
    if (reason !== null) return this.fail(c, { code: "EXPORT_UNAVAILABLE", exportReason: reason });
    const refusal = this.libraryGate() ?? this.activeAvatarRefusal(spec.avatarId);
    if (refusal) return this.fail(c, refusal);
    const cells = sceneCells(spec);
    const unavailable = cells.filter((cell) => !this.photoUsable(spec.avatarId, cell.photoId));
    if (unavailable.length > 0) return this.fail(c, { code: "PHOTO_UNAVAILABLE", issues: unavailable.slice(0, MAX_MONTAGE_ISSUES).map((cell) => ({ code: "photo-unavailable" as const, path: cell.path })) });
    if (this.renderJobs.filter(isActive).length >= this.renderQueueLimit) {
      return this.fail(c, { code: "RENDER_QUEUE_FULL", detail: renderQueueFullDetail(this.renderQueueLimit) });
    }

    const job: MockRenderJob = {
      jobId: this.nextId("job"),
      videoId: this.nextId("video"),
      avatarId: spec.avatarId,
      montageId,
      title,
      spec,
      photoIds: cells.map((cell) => cell.photoId),
      mediaIds: [...new Set(ownPhotoCells(spec).map((cell) => cell.mediaId))],
      status: "queued",
      done: 0,
      total: totalFrames(spec.clips),
      saving: false,
      cancelling: false,
      error: null,
      result: null,
      timers: [],
    };
    // The photos are reserved now: the avatar's eligibleUnusedCount moved.
    this.movingUsage(job.avatarId, job.photoIds, () => void this.renderJobs.push(job));
    this.pumpRenders();
    // A render that has to wait is announced now; one that started already was, by its start.
    if (job.status === "queued") this.emitRenderProgress(job);
    this.announceAvatar(job.avatarId);
    return this.ok(c, { jobId: job.jobId, videoId: job.videoId });
  }

  private emitRenderProgress(job: MockRenderJob): void {
    this.emit({
      v: PROTOCOL_VERSION,
      id: this.nextId("evt"),
      kind: "event",
      type: "job.progress",
      payload: { kind: "render", jobId: job.jobId, videoId: job.videoId, avatarId: job.avatarId, montageId: job.montageId, done: job.done, total: job.total, ...(job.saving ? { saving: true } : {}), ...(job.status === "queued" ? { queued: true } : {}) },
    });
  }

  /** Starts the queued renders that fit the pool, first in, first out. */
  private pumpRenders(): void {
    for (;;) {
      if (this.renderJobs.filter((j) => j.status === "running").length >= this.renderPoolSize()) return;
      const next = this.renderJobs.find((j) => j.status === "queued");
      if (next === undefined) return;
      this.startRenderJob(next);
    }
  }

  /** The job's clock: the start is announced at zero, then `MOCK_RENDER_STEPS` steps that never reach the total, the saving phase, and the commit. */
  private startRenderJob(job: MockRenderJob): void {
    job.status = "running";
    this.emitRenderProgress(job);
    const advance = (step: number): void => {
      job.timers.push(
        this.scheduler.schedule(this.stepMs, () => {
          // An encode failure stops the job at its first step, before it reports anything.
          if (step === 1 && this.nextRenderFailure?.at === "encode") {
            const { error } = this.nextRenderFailure;
            this.nextRenderFailure = null;
            this.endRender(job, "failed", error);
            return;
          }
          if (step <= MOCK_RENDER_STEPS) {
            job.done = mockRenderDone(step, job.total);
            this.emitRenderProgress(job);
            advance(step + 1);
          } else if (step === MOCK_RENDER_STEPS + 1) {
            job.saving = true;
            this.emitRenderProgress(job);
            advance(step + 1);
          } else {
            this.commitRender(job);
          }
        }),
      );
    };
    advance(1);
  }

  /** The commit: the record lands (and the window is told, before the job ends), then the job ends `done`. A scripted failure ends it `failed` instead. */
  private commitRender(job: MockRenderJob): void {
    const failure = this.nextRenderFailure;
    if (failure?.at === "saving") {
      this.nextRenderFailure = null;
      this.endRender(job, "failed", failure.error);
      return;
    }
    if (failure?.at === "late") {
      // The engine's commit that outlived its deadline past the claim: the job reports failed, and the record lands later anyway.
      this.nextRenderFailure = null;
      this.endRender(job, "failed", failure.error);
      this.scheduler.schedule(this.stepMs, () => {
        this.movingUsage(job.avatarId, job.photoIds, () => this.recordVideo(job));
        this.announceAvatar(job.avatarId);
      });
      return;
    }
    const { relPath, bytes, durationMs, kind } = this.recordVideo(job);
    this.announceAvatar(job.avatarId);

    job.status = "done";
    job.done = job.total;
    job.result = { kind: "render", videoId: job.videoId, avatarId: job.avatarId, bytes, durationMs, videoKind: kind, relPath };
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "job.done", payload: { jobId: job.jobId, result: job.result } });
    this.announceAvatar(job.avatarId);
    this.trimFinishedRenders();
    this.pumpRenders();
  }

  /** The record of `job`'s video lands: the file is named, the record kept, `video.changed` sent (the caller announces the avatar). */
  private recordVideo(job: MockRenderJob): { relPath: string; bytes: number; durationMs: number; kind: string } {
    const { spec } = job;
    const avatar = this.avatars.find((a) => a.avatarId === job.avatarId);
    const kind = videoKindOf(spec.clips);
    const relPath = mockRelPath(mockFolderName(avatar?.name ?? "", job.avatarId), new Date(this.clock).toISOString().slice(0, 10), kind, this.exportFiles);
    this.exportFiles.add(relPath);
    const durationMs = spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);
    const bytes = estimateBytes(spec.clips);
    const montageId = this.liveDraft(job.montageId);
    // The tile's music (K13): the stored track the video was rendered with, as the engine writes it from the track it opened.
    const trending = spec.music?.source === "trending" ? spec.music.trackId : null;
    const track = trending === null ? undefined : this.music.tracks.find((t) => t.summary.trackId === trending)?.summary;
    const summary: VideoSummary = {
      videoId: job.videoId,
      avatarId: job.avatarId,
      kind,
      durationMs,
      bytes,
      createdAt: this.nowIso(),
      relPath,
      fileState: "present",
      montageId,
      photoCount: job.photoIds.length,
      music: track === undefined ? null : { title: track.title, artist: track.artist, trackId: track.trackId },
      hasPoster: false,
      title: job.title,
      // The first clip as it was rendered: the tile's still (3e.2), as the engine reads it from the record.
      firstClip: spec.clips[0] ?? null,
    };
    this.videos.push({ summary, photoIds: job.photoIds, montageId, fileState: null, rootId: this.exportRootId });
    this.adjustAvatar(job.avatarId, { videoCount: 1 });
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "video.changed", payload: { change: "upserted", video: summary } });
    return { relPath, bytes, durationMs, kind };
  }

  /** A render that ends without a video: its photos leave the reservation, then the window is told, then the next queued render starts. */
  private endRender(job: MockRenderJob, status: "cancelled" | "failed", error?: EngineError): void {
    for (const cancel of job.timers) cancel();
    job.timers = [];
    this.movingUsage(job.avatarId, job.photoIds, () => {
      job.status = status;
      job.error = error ?? null;
    });
    const ref = { kind: "render" as const, jobId: job.jobId, videoId: job.videoId, avatarId: job.avatarId, montageId: job.montageId };
    if (status === "failed") this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "job.failed", payload: { ...ref, error: error ?? { code: "INTERNAL", detail: "the render failed" } } });
    else this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "job.cancelled", payload: ref });
    this.announceAvatar(job.avatarId);
    this.trimFinishedRenders();
    this.pumpRenders();
  }

  /** The registry keeps the latest finished jobs: the snapshot lists at most this many after the queued and running ones. */
  private trimFinishedRenders(): void {
    const finished = this.renderJobs.filter((j) => !isActive(j));
    const drop = new Set(finished.slice(0, Math.max(0, finished.length - MOCK_KEEP_FINISHED_RENDERS)));
    if (drop.size > 0) this.renderJobs = this.renderJobs.filter((j) => !drop.has(j));
  }

  private videosCancel(c: CommandMessage, jobId: string): ResponseMessage {
    const job = this.renderJobs.find((j) => j.jobId === jobId);
    if (job === undefined) return this.fail(c, { code: "NOT_FOUND", detail: `no render job ${jobId}` });
    if (job.status === "queued") {
      this.endRender(job, "cancelled");
    } else if (job.status === "running" && !job.saving && !job.cancelling) {
      // The command answers before the work has stopped; the job ends a moment later. Past the point of no return a cancel is ignored: done wins.
      job.cancelling = true;
      for (const cancel of job.timers) cancel();
      job.timers = [this.scheduler.schedule(CANCEL_CONFIRM_DELAY_MS, () => this.endRender(job, "cancelled"))];
    }
    return this.ok(c, { jobId });
  }

  /** Main's `videos.reveal` (no engine has it): only a video whose file is present in the current export folder is shown. */
  private videosReveal(c: CommandMessage, videoId: string): ResponseMessage {
    const video = this.videos.find((v) => v.summary.videoId === videoId);
    if (video === undefined) return this.fail(c, { code: "NOT_FOUND", detail: `no video ${videoId}` });
    this.checkExport();
    const state = this.fileStateOf(video);
    if (state !== "present") return this.fail(c, { code: "NOT_FOUND", detail: `the video's file is not in the export folder (${state})` });
    this.revealed.push(videoId);
    return this.ok(c, { videoId });
  }

  /**
   * Main's «Папка «Готовые видео»» (3e.2, K17; no engine has it): the export folder is checked, then the avatar's folder is
   * opened when one of its videos lives in this export folder, else the export folder itself. Nothing opens in the mock: it
   * remembers the avatar.
   */
  private videosRevealFolder(c: CommandMessage, avatarId: string): ResponseMessage {
    const reason = this.checkExport();
    if (reason !== null) return this.fail(c, { code: "EXPORT_UNAVAILABLE", exportReason: reason });
    if (!this.libraryOpen || !this.avatarKnown(avatarId)) return this.fail(c, { code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    const own = this.videos.some((v) => v.summary.avatarId === avatarId && v.rootId === this.exportRootId && this.fileStateOf(v) !== "elsewhere");
    this.revealedFolders.push(avatarId);
    return this.ok(c, { opened: own ? "avatar" : "root" });
  }

  /** One video by id, as `videos.list` shows it, its file looked at now (3e.2). */
  private videosGet(c: CommandMessage, videoId: string): ResponseMessage {
    const video = this.libraryOpen ? this.videos.find((v) => v.summary.videoId === videoId) : undefined;
    if (video === undefined) return this.fail(c, { code: "NOT_FOUND", detail: `no video ${videoId}` });
    this.checkExport();
    return this.ok(c, { video: { ...video.summary, fileState: this.fileStateOf(video), montageId: this.liveDraft(video.montageId) } });
  }

  /**
   * One of the two usage recoveries (3e.2, K16): the mock has no disk, so an avatar's broken records or marks are the reason its
   * summary was seeded with, and the recovery clears its own reason (the others stay). `answer` builds the result from whether it
   * cleared one. The avatar is announced only when its summary moved, as the engine does.
   */
  private clearUsageReason(c: CommandMessage, avatarId: string, reason: UsageUnknownReason, answer: (cleared: boolean) => Record<string, unknown>): ResponseMessage {
    const gone = this.libraryGate();
    if (gone) return this.fail(c, gone);
    const avatar = this.avatars.find((a) => a.avatarId === avatarId);
    if (avatar === undefined) return this.fail(c, { code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    const reasons = avatar.usage.state === "unknown" ? avatar.usage.reasons : [];
    const cleared = reasons.includes(reason);
    if (cleared) {
      const [first, ...rest] = reasons.filter((r) => r !== reason);
      const usage: AvatarSummary["usage"] = first === undefined ? { state: "ok" } : { state: "unknown", reasons: [first, ...rest] };
      // Trusted again: the photos a montage may use count once more (eligible, in no video and no render).
      const eligibleUnusedCount = usage.state === "ok" ? this.photos.filter((p) => p.avatarId === avatarId).map((p) => this.photoView(p)).filter((p) => p.eligible && !p.used && !p.reserved).length : 0;
      this.avatars = this.avatars.map((a) => (a.avatarId === avatarId ? { ...a, usage, eligibleUnusedCount } : a));
      this.announceAvatar(avatarId);
    }
    return this.ok(c, { avatarId, ...answer(cleared) });
  }

  private videosList(c: CommandMessage, avatarId: string): ResponseMessage {
    if (!this.libraryOpen || !this.avatarKnown(avatarId)) return this.fail(c, { code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    this.checkExport();
    const videos = this.videos
      .filter((v) => v.summary.avatarId === avatarId)
      .map((v): VideoSummary => ({ ...v.summary, fileState: this.fileStateOf(v), montageId: this.liveDraft(v.montageId) }))
      .reverse()
      .slice(0, MAX_LISTED_VIDEOS);
    return this.ok(c, { videos });
  }

  private videosDelete(c: CommandMessage, payload: { videoId: string; mode: "video" | "record" }): ResponseMessage {
    const { videoId, mode } = payload;
    const gone = this.libraryGate();
    if (gone) return this.fail(c, gone);
    // «Удалить» needs a usable folder, asked before the video is looked for: a sleeping drive must never turn it into a record-only delete.
    const reason = this.checkExport();
    if (mode === "video" && reason !== null) return this.fail(c, { code: "EXPORT_UNAVAILABLE", exportReason: reason });
    const video = this.videos.find((v) => v.summary.videoId === videoId);
    if (video === undefined) return this.fail(c, { code: "NOT_FOUND", detail: `no video ${videoId}` });
    const state = this.fileStateOf(video);
    if (mode === "video" && state === "elsewhere") return this.fail(c, { code: "EXPORT_UNAVAILABLE", exportReason: "missing", detail: "the video's file is not in the current export folder" });
    const fileDeleted = mode === "video" && state === "present";
    const { avatarId } = video.summary;
    this.movingUsage(avatarId, video.photoIds, () => {
      this.videos = this.videos.filter((v) => v !== video);
      if (fileDeleted) this.exportFiles.delete(video.summary.relPath);
    });
    this.adjustAvatar(avatarId, { videoCount: -1 });
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "video.changed", payload: { change: "removed", videoId, avatarId } });
    this.announceAvatar(avatarId);
    return this.ok(c, { videoId, fileDeleted, fileState: state });
  }

  private renderJobState(j: MockRenderJob): JobState {
    return {
      kind: "render",
      jobId: j.jobId,
      videoId: j.videoId,
      avatarId: j.avatarId,
      montageId: j.montageId,
      status: j.status,
      done: j.done,
      total: j.total,
      ...(j.saving && j.status === "running" ? { saving: true } : {}),
      ...(j.status === "failed" && j.error !== null ? { error: j.error } : {}),
      ...(j.status === "done" && j.result !== null ? { result: j.result } : {}),
    };
  }

  // ---------- photo runs (T8b) ----------

  /** The engine's `#liveLibrary()`: no library open refuses a paid run command before it looks at what the command names. */
  private libraryGate(): EngineError | null {
    return this.libraryOpen ? null : { code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" };
  }

  /** A run start's master check: NOT_FOUND when the avatar's master photo is gone. */
  private masterRefusal(avatarId: string): EngineError | null {
    return this.mastersMissing.has(avatarId) ? { code: "NOT_FOUND", detail: `avatar ${avatarId} has no usable master photo to use as the face reference` } : null;
  }

  /** The engine's `#assertAgeGate` (only when the run's image age check is on) and then `#assertFaceGate`. */
  private gateRefusal(ageCheckOn: boolean): EngineError | null {
    if (ageCheckOn && !this.ageGateAvailable) {
      return { code: "AGE_GATE_UNAVAILABLE", detail: "the image age check is on, but this build has no age gate among the engine's QA gates" };
    }
    if (!this.faceGate.available) {
      const base = "no face gate is wired into photo runs; restart Studio, or reinstall it if this persists";
      return { code: "FACE_GATE_UNAVAILABLE", detail: this.faceGate.loadError === undefined ? base : `${base} (${this.faceGate.loadError})` };
    }
    return null;
  }

  /** runs.estimate/start/resume's avatar check: NOT_FOUND unless it is saved and active, DESCRIPTOR_INVALID for a descriptor to rewrite first. */
  private runnableRefusal(avatarId: string): EngineError | null {
    const avatar = this.avatars.find((a) => a.avatarId === avatarId);
    if (avatar?.status !== "active") return { code: "NOT_FOUND", detail: `avatar ${avatarId} is not a saved, active avatar` };
    if (!AvatarDescriptor.safeParse(avatar.descriptor).success) return { code: "DESCRIPTOR_INVALID" };
    return null;
  }

  /** A whole run at today's mock prices: every slot's every attempt, the writer chunked, and the age checks when they are on. */
  private runPrice(request: Pick<RunRequest, "count">): Estimate {
    const { count } = request;
    const image = this.runImagePrice;
    const attempts = count * MOCK_RUN_ATTEMPTS_PER_SLOT;
    const ageOn = this.settings.imageAgeCheck === "on";
    const chunks = Math.ceil(count / MOCK_RUN_WRITER.photosPerChunk);
    return {
      expectedMicros: count * image + count * MOCK_RUN_WRITER.expectedPerPhoto + (ageOn ? count * MOCK_AGE_CHECK_PER_SLOT.expected : 0),
      worstMicros: attempts * image + chunks * MOCK_RUN_WRITER.worstPerChunk + (ageOn ? attempts * MOCK_AGE_CHECK_PER_SLOT.worst : 0),
      prices: this.price.prices,
      pricesAsOf: this.price.pricesAsOf,
    };
  }

  private openSlots(run: MockRun): number {
    return run.slots.filter((s) => s.end === null).length;
  }

  /** This run's own most recently started job, whatever its status — unlike `activeRunJob`, also finds a cancelled one whose in-flight slots' reserves (MEDIUM-2) are still its own to count. */
  private latestRunJobOf(runId: string): MockRunJob | null {
    for (let i = this.runJobs.length - 1; i >= 0; i--) {
      const job = this.runJobs[i];
      if (job !== undefined && job.runId === runId) return job;
    }
    return null;
  }

  /**
   * What the run has committed: its settled money plus the reserves its own
   * job still holds open — a running job's every open slot, or (MEDIUM-2)
   * a cancelled job's surviving in-flight ones, exactly as `cancelRunJob`
   * left `reserveKeys`. Mirrors the real engine's `scopeCommitted`, which
   * counts open reserves regardless of whether the job that opened them is
   * still running (`studio/engine/runs/remaining.ts`).
   */
  private runCommitted(run: MockRun): number {
    const job = this.latestRunJobOf(run.runId);
    const open = job ? job.reserveKeys.reduce((sum, key) => sum + (this.reserves.get(key) ?? 0), 0) : 0;
    return run.settledMicros + open;
  }

  /**
   * One slot of `run` at today's prices: what a success is expected to cost
   * (one image, and its age check when the run has them) and the worst case
   * of one attempt. The age-check mode is the run's own, captured at start.
   */
  private slotPrice(run: MockRun): { expected: number; attemptWorst: number } {
    const image = this.runImagePrice;
    return {
      expected: image + (run.ageCheck ? MOCK_AGE_CHECK_PER_SLOT.expected : 0),
      attemptWorst: image + (run.ageCheck ? MOCK_AGE_CHECK_PER_SLOT.worst : 0),
    };
  }

  /**
   * A stored run photo's own avatar summary gains one to its photoCount and
   * announces avatar.changed, like the real engine does per photo
   * (`engine.ts:1245`, MEDIUM-3). Keeps the rule photoCount = gallery
   * photos, so the Avatars grid and the Photos screen's own gallery count
   * never drift apart, the way the demo's Mia once did.
   */
  private bumpPhotoCount(avatarId: string): void {
    const avatar = this.avatars.find((a) => a.avatarId === avatarId);
    if (avatar === undefined) return;
    const updated = { ...avatar, photoCount: avatar.photoCount + 1, eligibleUnusedCount: avatar.eligibleUnusedCount + 1 };
    this.avatars = this.avatars.map((a) => (a === avatar ? updated : a));
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "avatar.changed", payload: { avatar: updated } });
  }

  /** The avatar's eligibleUnusedCount moves by `delta` (a photo rejected or restored) and avatar.changed announces it, like the real engine. */
  private shiftEligibleUnused(avatarId: string, delta: number): void {
    const avatar = this.avatars.find((a) => a.avatarId === avatarId);
    if (avatar === undefined) return;
    const updated = { ...avatar, eligibleUnusedCount: Math.max(0, avatar.eligibleUnusedCount + delta) };
    this.avatars = this.avatars.map((a) => (a === avatar ? updated : a));
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "avatar.changed", payload: { avatar: updated } });
  }

  /** What a resume could still spend: its open slots' attempts at today's prices, never more than the cap leaves. */
  private resumePrice(run: MockRun): Estimate {
    const open = this.openSlots(run);
    const slot = this.slotPrice(run);
    const capLeft = Math.max(0, run.capMicros - this.runCommitted(run));
    // The real engine's remainingEstimate: an unwritten chunk adds the writer's ceiling (the mock has one chunk per 25 photos of the run), and its typical share per scene.
    const writerWorst = run.writerDone ? 0 : Math.ceil(run.slots.length / MOCK_RUN_WRITER.photosPerChunk) * MOCK_RUN_WRITER.worstPerChunk;
    const writerExpected = run.writerDone ? 0 : run.slots.length * MOCK_RUN_WRITER.expectedPerPhoto;
    const worstMicros = Math.min(open * MOCK_RUN_ATTEMPTS_PER_SLOT * slot.attemptWorst + writerWorst, capLeft);
    return { expectedMicros: Math.min(open * slot.expected + writerExpected, worstMicros), worstMicros, prices: this.price.prices, pricesAsOf: this.price.pricesAsOf };
  }

  /**
   * Whether the run's cap leaves too little to fund one more attempt, so it
   * has ended (protocol 4): a stopped run with open slots, like the real
   * engine's `capFundsResume`. A running one is never ended by it.
   */
  private capExhausted(run: MockRun): boolean {
    if (this.activeRunJob(run.runId) !== null || this.openSlots(run) === 0) return false;
    // Not while the run's OWN open reserves wait for a reconcile: they count at their worst case until then, so the room
    // is not final. Another scope's reserve or a torn line does not change this run's committed money (the real engine's
    // `Budget.scopeNeedsReconcile`).
    const own = this.latestRunJobOf(run.runId);
    if (own !== null && own.reserveKeys.some((key) => this.reserves.has(key))) return false;
    // The real engine's minToProgress: ONE writer call's ceiling for an unwritten chunk (the writer runs first) plus one image attempt.
    const writer = run.writerDone ? 0 : MOCK_RUN_WRITER.worstPerCall;
    return run.capMicros - this.runCommitted(run) < writer + this.slotPrice(run).attemptWorst;
  }

  private capEndedError(run: MockRun): EngineError {
    return { code: "RUN_CAP_EXCEEDED", detail: `run ${run.runId}'s cap leaves too little for one more attempt: it has ended` };
  }

  /**
   * Every run, newest `createdAt` first, tied by `runId` descending (L7: the
   * real engine's own #listRuns sort, `engine.ts:1068`) — never insertion
   * order: a seeded run's own `createdAt` runs backwards from
   * `START_OF_TIME` as more are seeded, so it cannot be relied on to already
   * be in date order the way a live run's `nowIso()` (forward-ticking) is.
   */
  private sortedRuns(): MockRun[] {
    return [...this.runs].sort((a, b) => (a.createdAt === b.createdAt ? (a.runId < b.runId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
  }

  private runSummary(run: MockRun): RunSummary {
    const done = run.slots.filter((s) => s.end === "done").length;
    const failed = run.slots.filter((s) => s.end === "failed").length;
    const open = this.openSlots(run);
    const running = this.activeRunJob(run.runId) !== null;
    const capExhausted = this.capExhausted(run);
    return {
      runId: run.runId,
      avatarId: run.avatarId,
      createdAt: run.createdAt,
      total: run.slots.length,
      done,
      failed,
      open,
      capMicros: run.capMicros,
      committedMicros: this.runCommitted(run),
      running,
      resumable: !running && open > 0 && !capExhausted,
      capExhausted,
      remainingWorstMicros: this.resumePrice(run).worstMicros,
    };
  }

  private activeRunJob(runId: string): MockRunJob | null {
    return this.runJobs.find((j) => j.runId === runId && (j.status === "queued" || j.status === "running")) ?? null;
  }

  /**
   * A job over the run's open slots, one step each: a photo stored (with its
   * similarity, or none) and its reserve settled, or — for the trailing
   * `failNextRunSlots` — the slot ended without one. `done` starts at the
   * slots already ended, so a resume continues the run's own count.
   */
  private startRunJob(run: MockRun): string {
    const openIndexes = run.slots.flatMap((s, i) => (s.end === null ? [i] : []));
    const failing = Math.min(this.failedRunSlotsNext, openIndexes.length);
    this.failedRunSlotsNext = 0;
    // Fixed at job start, like the real reserve: a later setRunImagePrice must not change what a slot already owes.
    const slot = this.slotPrice(run);
    const job: MockRunJob = {
      jobId: this.nextId("job"),
      runId: run.runId,
      avatarId: run.avatarId,
      status: "queued",
      done: run.slots.length - openIndexes.length,
      total: run.slots.length,
      error: null,
      reserveKeys: openIndexes.map((i) => this.slotReserveKey(run.runId, i + 1)),
      cancelTimers: [],
    };
    this.runJobs = [...this.runJobs, job];
    // N6: reserved at most what the cap leaves, in total — every open slot's
    // full worst case regardless of the cap could push committedMicros past
    // it (a capped resume, whose runs.estimateResume already capped this
    // same sum). Matches resumePrice's own min(rawRemaining, capLeft).
    let capLeft = Math.max(0, run.capMicros - run.settledMicros);
    for (const key of job.reserveKeys) {
      const reserve = Math.min(MOCK_RUN_ATTEMPTS_PER_SLOT * slot.attemptWorst, capLeft);
      this.reserves.set(key, reserve);
      capLeft -= reserve;
    }
    this.emitMoney();

    // Announced at launch, like the engine: a window that did not start the run sees (and can cancel) it before its first slot ends.
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "job.progress", payload: { kind: "run", jobId: job.jobId, runId: job.runId, avatarId: job.avatarId, done: job.done, total: job.total } });
    // The writer answers first, whatever a later stop does; the mock has no phase of its own for it.
    run.writerDone = true;
    // A master that is gone is found by the job's own loadMaster, as in the real engine: the job fails NOT_FOUND before any slot.
    if (this.mastersMissing.has(run.avatarId)) {
      job.cancelTimers.push(
        this.scheduler.schedule(this.stepMs, () => this.failRunJob(job, { code: "NOT_FOUND", detail: `avatar ${run.avatarId} has no usable master photo to use as the face reference` })),
      );
      return job.jobId;
    }

    openIndexes.forEach((slotIndex, step) => {
      job.cancelTimers.push(
        this.scheduler.schedule(this.stepMs * (step + 1), () => {
          const planned = run.slots[slotIndex];
          if (planned === undefined) return;
          const key = this.slotReserveKey(run.runId, slotIndex + 1);
          this.reserves.delete(key);
          job.reserveKeys = job.reserveKeys.filter((k) => k !== key);
          if (step >= openIndexes.length - failing) {
            // Every attempt was refused or failed: a definite non-2xx each time, settled at zero.
            planned.end = "failed";
            this.emitMoney();
          } else {
            planned.end = "done";
            const photoId = this.nextId("photo");
            const qa = mockFaceQa(slotIndex);
            this.photos.push({ photoId, avatarId: run.avatarId, runId: run.runId, category: planned.category, createdAt: this.nowIso(), used: false, usedIn: [], rejected: false, reserved: false, eligible: true, ...(qa ? { qa } : {}) });
            run.photoIds.push(photoId);
            run.settledMicros += slot.expected;
            this.spend(slot.expected);
            this.bumpPhotoCount(run.avatarId);
          }
          job.status = "running";
          job.done += 1;
          this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "job.progress", payload: { kind: "run", jobId: job.jobId, runId: job.runId, avatarId: job.avatarId, done: job.done, total: job.total } });
        }),
      );
    });
    job.cancelTimers.push(this.scheduler.schedule(this.stepMs * (openIndexes.length + 1), () => this.finishRunJob(job, run)));
    return job.jobId;
  }

  private finishRunJob(job: MockRunJob, run: MockRun): void {
    job.status = "done";
    job.cancelTimers = [];
    this.emit({
      v: PROTOCOL_VERSION,
      id: this.nextId("evt"),
      kind: "event",
      type: "job.done",
      payload: { jobId: job.jobId, result: this.runResult(run) },
    });
  }

  private runResult(run: MockRun): Extract<JobResult, { kind: "run" }> {
    return { kind: "run", runId: run.runId, avatarId: run.avatarId, photoIds: [...run.photoIds], failedSlots: run.slots.filter((s) => s.end === "failed").length };
  }

  /**
   * No more slots are drawn from the answer on, but the job itself ends on a
   * later tick (job.cancelled). Only the slots actually in flight — bounded
   * by the network's own concurrency, never every open slot at once
   * (MEDIUM-2: the mock reserves per slot upfront, but a slot past that
   * bound was never actually dispatched) — keep their reserve open at its
   * worst case, unknown whether OpenRouter billed it, exactly like the real
   * engine's own open-reserves rule (`studio/engine/engine.ts`'s
   * `#moneyStatus`: `status.openAttempts - budget.inFlightCount() > 0`) and
   * like the mock's own avatars.cancel (candidate batches, at most 4 slots,
   * so every one of them is already "in flight" by this same rule). The rest
   * are released for free — never sent, never billable — same as
   * avatars.cancel's own untouched reserves would be past its own slot
   * count. The slots stay open in the run, which a resume can continue once
   * reconciled.
   */
  private cancelRunJob(job: MockRunJob): void {
    for (const cancel of job.cancelTimers) cancel();
    const inFlight = Math.min(this.settings.concurrency.network, job.reserveKeys.length);
    const release = job.reserveKeys.slice(inFlight);
    job.reserveKeys = job.reserveKeys.slice(0, inFlight);
    for (const key of release) this.reserves.delete(key);
    if (job.reserveKeys.length > 0 && !this.reconcileReasons.includes("open-reserves")) {
      this.reconcileReasons = [...this.reconcileReasons, "open-reserves"];
    }
    this.emitMoney();
    job.cancelTimers = [
      this.scheduler.schedule(CANCEL_CONFIRM_DELAY_MS, () => {
        job.status = "cancelled";
        job.cancelTimers = [];
        this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "job.cancelled", payload: { kind: "run", jobId: job.jobId, runId: job.runId, avatarId: job.avatarId } });
      }),
    ];
  }

  private runJobState(j: MockRunJob): JobState {
    const base = { kind: "run" as const, jobId: j.jobId, runId: j.runId, avatarId: j.avatarId, status: j.status, done: j.done, total: j.total };
    const run = this.runs.find((r) => r.runId === j.runId);
    if (j.status === "done" && run) return { ...base, result: this.runResult(run) };
    if (j.status === "failed" && j.error) return { ...base, error: j.error };
    return base;
  }

  /** One slot's own reserve, keyed apart from its siblings: cancel, a crash, or `reserveLeftOpen` can leave just this one open. */
  private slotReserveKey(jobId: string, slot: number): string {
    return `${jobId}#${slot}`;
  }

  private startJob(avatarId: string): string {
    const total = CANDIDATES_PER_JOB;
    // Off means no age check runs at all, so nothing can reject a slot for
    // it, whatever a test forced with rejectNextByAgeCheck. Captured at job
    // start, like the price below: a later settings.setImageAgeCheck must not
    // affect a job already running (mirrors the real engine's own capture).
    const ageRejected = this.settings.imageAgeCheck === "on" ? this.ageRejectionsNextJob : 0;
    this.ageRejectionsNextJob = 0;
    const failedSpec = this.failedSlotsNextJob;
    this.failedSlotsNextJob = null;
    const failedCount = failedSpec?.count ?? 0;
    const failedError: EngineError = failedSpec?.error ?? { code: "INTERNAL" };
    const failedReserveLeftOpen = failedSpec?.reserveLeftOpen ?? false;
    // Fixed at job start, like the reserve itself: a later setPrice() (or
    // settings.setImageAgeCheck) must not change what an already-running slot owes.
    const jobPrice = this.currentPrice();
    const perSlotWorst = Math.round((jobPrice.worstMicros - DESCRIPTOR.worst) / total);
    const perSlotExpected = Math.round((jobPrice.expectedMicros - DESCRIPTOR.expected) / total);

    const job: MockJob = {
      jobId: this.nextId("job"),
      avatarId,
      status: "queued",
      done: 0,
      total,
      candidates: [],
      rejectedByAgeCheck: 0,
      failedSlots: [],
      error: null,
      cancelTimers: [],
    };
    this.jobs = [...this.jobs, job];
    // Reserved per slot, not as one lump for the whole batch: a cancel, a
    // crash, or a `reserveLeftOpen` failure then leaves only its own slots'
    // reserves open, exactly as the real engine's per-attempt reserves would.
    for (let slot = 1; slot <= total; slot++) this.reserves.set(this.slotReserveKey(job.jobId, slot), perSlotWorst);
    this.emitMoney();

    // Each slot lands on its own step: a success is appended to the draft
    // right away (draft.changed), one at a time, exactly as a real run would
    // report each portrait as it clears its age check. Its reserve is settled
    // the same moment, not batched to the job's end.
    for (let step = 1; step <= total; step++) {
      job.cancelTimers.push(
        this.scheduler.schedule(this.stepMs * step, () => {
          job.status = "running";
          job.done = step;
          const outcome = slotOutcome(step, total, ageRejected, failedCount);
          const reserveKey = this.slotReserveKey(job.jobId, step);
          if (outcome === "success") {
            const candidate: Candidate = { avatarId: job.avatarId, photoId: this.nextId("photo") };
            job.candidates = [...job.candidates, candidate];
            const draft = this.drafts.find((d) => d.avatarId === avatarId);
            if (draft) {
              const updated: Draft = { ...draft, candidates: [...draft.candidates, candidate] };
              this.drafts = this.drafts.map((d) => (d === draft ? updated : d));
              this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "draft.changed", payload: { draft: updated } });
            }
            // A 2xx generation, billed regardless of the (later) pick decision.
            this.reserves.delete(reserveKey);
            this.spend(perSlotExpected);
          } else if (outcome === "age-rejected") {
            job.rejectedByAgeCheck += 1;
            job.failedSlots = [...job.failedSlots, { slot: step, reason: "age-rejected" }];
            // The image itself still generated (a 2xx) before the age check dropped it: billed all the same.
            this.reserves.delete(reserveKey);
            this.spend(perSlotExpected);
          } else {
            job.failedSlots = [...job.failedSlots, { slot: step, reason: "failed", error: failedError, reserveLeftOpen: failedReserveLeftOpen }];
            if (failedReserveLeftOpen) {
              // A timeout or network error: unknown whether OpenRouter billed it, so the reserve stays open until reconciled.
              this.emitMoney();
            } else {
              // A definite non-2xx (a moderation refusal, say): settled at its known cost of zero.
              this.reserves.delete(reserveKey);
              this.emitMoney();
            }
          }
          this.emit({
            v: PROTOCOL_VERSION,
            id: this.nextId("evt"),
            kind: "event",
            type: "job.progress",
            payload: { kind: "avatar.candidates", jobId: job.jobId, avatarId: job.avatarId, done: job.done, total: job.total },
          });
        }),
      );
    }
    job.cancelTimers.push(this.scheduler.schedule(this.stepMs * (total + 1), () => this.finishJob(job)));
    return job.jobId;
  }

  private finishJob(job: MockJob): void {
    job.status = "done";
    job.done = job.total;
    // Every slot settled (or, for `reserveLeftOpen`, stayed open) as it landed above: nothing left to spend here.
    this.emit({
      v: PROTOCOL_VERSION,
      id: this.nextId("evt"),
      kind: "event",
      type: "job.done",
      payload: {
        jobId: job.jobId,
        result: {
          kind: "avatar.candidates",
          avatarId: job.avatarId,
          candidates: job.candidates,
          rejectedByAgeCheck: job.rejectedByAgeCheck,
          failedSlots: job.failedSlots,
        },
      },
    });
  }

  private failJob(job: MockJob, error: EngineError): void {
    for (const cancel of job.cancelTimers) cancel();
    job.cancelTimers = [];
    job.status = "failed";
    job.error = error;
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "job.failed", payload: { kind: "avatar.candidates", jobId: job.jobId, avatarId: job.avatarId, error } });
  }

  /** A run job fails as a whole (e.g. AUTH_INVALID): its open slots stay open for a resume, their unsent reserves released. */
  private failRunJob(job: MockRunJob, error: EngineError): void {
    for (const cancel of job.cancelTimers) cancel();
    job.cancelTimers = [];
    for (const key of job.reserveKeys) this.reserves.delete(key);
    job.reserveKeys = [];
    job.status = "failed";
    job.error = error;
    this.emitMoney();
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "job.failed", payload: { kind: "run", jobId: job.jobId, runId: job.runId, avatarId: job.avatarId, error } });
  }

  // ---------- state ----------

  private snapshot(): Snapshot {
    return {
      bootId: this.log.bootId,
      lastSeq: this.log.lastSeq,
      settings: this.settings,
      money: this.moneyStatus(),
      avatars: this.avatars,
      drafts: this.drafts,
      unreadableAvatars: this.unreadable,
      unreadableTotal: this.unreadableCount(),
      jobs: [...this.jobs.map((j) => this.jobState(j)), ...this.runJobs.map((j) => this.runJobState(j)), ...this.renderJobs.map((j) => this.renderJobState(j)), ...this.ownMedia.jobStates()],
      librarySwitchGeneration: this.librarySwitchGeneration,
      exportStatus: this.exportReported,
      notices: [],
    };
  }

  private jobState(j: MockJob): JobState {
    const base = { kind: "avatar.candidates" as const, jobId: j.jobId, avatarId: j.avatarId, status: j.status, done: j.done, total: j.total };
    if (j.status === "done") {
      return {
        ...base,
        result: {
          kind: "avatar.candidates",
          avatarId: j.avatarId,
          candidates: j.candidates,
          rejectedByAgeCheck: j.rejectedByAgeCheck,
          failedSlots: j.failedSlots,
        },
      };
    }
    if (j.status === "failed" && j.error) return { ...base, error: j.error };
    return base;
  }

  /** Another batch for an existing draft: the price without the descriptor call. */
  private candidatesPrice(): Estimate {
    const base = this.currentPrice();
    const worstMicros = Math.max(0, base.worstMicros - DESCRIPTOR.worst);
    const expectedMicros = Math.min(worstMicros, Math.max(0, base.expectedMicros - DESCRIPTOR.expected));
    return { ...base, expectedMicros, worstMicros };
  }

  /** The descriptor-only recovery's price: the same descriptor sub-cost `candidatesPrice` subtracts, alone; never touches the image age check either way. */
  private rewritePrice(): Estimate {
    return { ...this.price, expectedMicros: DESCRIPTOR.expected, worstMicros: DESCRIPTOR.worst, ...this.rewritePriceOverride };
  }

  /** T6c's import job price: fixed, unaffected by settings.imageAgeCheck (its own one-time age check is mandatory either way). */
  private importPrice(): Estimate {
    return { ...this.importPriceValue };
  }

  /**
   * NOT_FOUND for an id that names nothing at all, or that names a
   * `manifest-unreadable` entry — the real engine's library never holds such
   * a manifest either, so it is exactly as unknown as an id that never
   * existed. VALIDATION for one this mock cannot rewrite — already fine
   * (listed normally), or unreadable for a `contract-mismatch` reason, or
   * seeded without a recovery target. Null when it is a rewritable
   * descriptor-invalid entry.
   */
  private rewriteRefusal(avatarId: string): EngineError | null {
    if (this.rewritable.has(avatarId)) return null;
    const entry = this.unreadable.find((u) => u.avatarId === avatarId);
    if (entry !== undefined) return entry.reason === "manifest-unreadable" ? { code: "NOT_FOUND" } : { code: "VALIDATION", detail: "nothing to rewrite" };
    const known = this.avatars.some((a) => a.avatarId === avatarId) || this.drafts.some((d) => d.avatarId === avatarId);
    return known ? { code: "VALIDATION", detail: "nothing to rewrite" } : { code: "NOT_FOUND" };
  }

  /** Turns a seeded unreadable entry into a normal draft or saved avatar with a freshly written descriptor; the master, candidates and name are untouched. */
  private applyRewrite(avatarId: string, target: RewriteTarget): void {
    this.unreadable = this.unreadable.filter((u) => u.avatarId !== avatarId);
    this.rewritable.delete(avatarId);
    const descriptor = mockDescriptor(target.traits);
    if (target.status === "draft") {
      const draft: Draft = {
        avatarId,
        traits: target.traits,
        descriptor,
        candidates: target.candidates ?? [],
        hiddenBelowThreshold: 0,
        estimate: this.candidatesPrice(),
      };
      this.drafts = [...this.drafts, draft];
      this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "draft.changed", payload: { draft } });
      return;
    }
    const avatar: AvatarSummary = {
      avatarId,
      name: target.name,
      descriptor,
      masterPhotoId: target.masterPhotoId ?? this.nextId("photo"),
      createdAt: target.createdAt ?? this.nowIso(),
      status: target.status,
      photoCount: target.photoCount ?? 0,
      videoCount: 0,
      eligibleUnusedCount: target.photoCount ?? 0,
      usage: { state: "ok" },
    };
    this.avatars = [...this.avatars, avatar];
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "avatar.changed", payload: { avatar } });
  }

  private moneyStatus(): MoneyStatus {
    const month = new Date(this.clock).toISOString().slice(0, 7);
    if (this.unavailable !== null) {
      return {
        ledger: "unavailable",
        month,
        monthlyBudgetMicros: this.settings.monthlyBudgetMicros,
        reconcileNeeded: false,
        reconcileReasons: [],
        halt: this.unavailable,
      };
    }
    return {
      ledger: "open",
      month,
      spentMicros: this.spentMicros,
      monthlyBudgetMicros: this.settings.monthlyBudgetMicros,
      unsettledMicros: this.unsettledMicros(),
      unsettledCount: this.reserves.size,
      reconcileNeeded: this.reconcileReasons.length > 0,
      reconcileReasons: this.reconcileReasons,
      halt: this.halt,
    };
  }

  /** `unreadableAvatars.length`, or a seeded override for testing the "N more" UI beyond the bounded list (L1). */
  private unreadableCount(): number {
    return Math.max(this.unreadable.length, this.unreadableTotalOverride ?? 0);
  }

  private unsettledMicros(): number {
    let total = 0;
    for (const worst of this.reserves.values()) total += worst;
    return total;
  }

  /** Every job still queued or running, candidate batches and photo runs alike: a library switch or a reconcile waits for them. */
  private running(): (MockJob | MockRunJob)[] {
    return [...this.jobs, ...this.runJobs].filter((j) => j.status === "queued" || j.status === "running");
  }

  private spend(micros: number): void {
    this.spentMicros += micros;
    this.spentSinceReconcile += micros;
    this.emitMoney();
  }

  // ---------- events ----------

  private emitMoney(): void {
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "money.changed", payload: { status: this.moneyStatus() } });
  }

  /** Mirrors the real engine's #emitSettings: every settings command emits this, so generation-based resync (store.ts) is exercised in mock/dev mode too. */
  // ---------- music (3c.6) ----------

  /** The status as the engine's music service builds it from its quota log and its track store. */
  private musicStatus(): MusicStatus {
    const m = this.music;
    const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());
    const list = m.list === null ? { listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 } : { listFetchedAt: iso(m.list.fetchedAt), trackCount: m.list.trackCount, bytesOnDisk: m.list.bytesOnDisk };
    // A log that cannot be read or trusted counts as the whole quota spent, as the engine's does.
    if (m.quotaLog === "corrupt" || m.quotaLog === "unreadable" || m.quotaLog === "missing") {
      return { ...list, sentLast31d: MUSIC_QUOTA_LIMIT, limit: MUSIC_QUOTA_LIMIT, serverRemaining: null, nextFreeAt: null, refresh: m.refresh, quotaLog: m.quotaLog };
    }
    const quota = mockQuota(m, this.clock);
    return { ...list, sentLast31d: Math.min(MUSIC_QUOTA_LIMIT, quota.sent), limit: MUSIC_QUOTA_LIMIT, serverRemaining: quota.serverRemaining, nextFreeAt: iso(quota.nextFreeAt), refresh: m.refresh, quotaLog: m.quotaLog };
  }

  /** `music.peaks`: an own track is not available until 3f; a trending track must be stored. The engine's wording. */
  private musicPeaks(c: CommandMessage, payload: { track: { source: "trending"; trackId: string } | { source: "own"; mediaId: string }; startMs: number; durationMs: number; bars: number }): ResponseMessage {
    const { track, startMs, durationMs, bars } = payload;
    if (track.source === "own") return this.fail(c, { code: "NOT_FOUND", detail: "own music is not available yet" });
    const peaks = peaksOfTrack(this.music.tracks, track.trackId, startMs, durationMs, bars);
    if (peaks === null) return this.fail(c, { code: "NOT_FOUND", detail: `track ${track.trackId} is not stored` });
    return this.ok(c, { peaks });
  }

  /** `montages.textPreview`, answered when the lane has drawn it: the picture, or the engine's refusal. */
  private async textPreview(c: CommandMessage, layer: TextLayer): Promise<ResponseMessage> {
    const outcome = await this.textPreviews.preview(layer);
    return outcome.ok ? this.ok(c, outcome.result) : this.fail(c, outcome.error);
  }

  /** `music.refresh {confirm: true}`, refused at no cost in the engine's order, else counted and answered running at once. */
  private musicRefresh(c: CommandMessage): ResponseMessage {
    const m = this.music;
    if (m.refresh.state === "running") return this.fail(c, { code: "IN_FLIGHT", detail: "a music refresh is already running" });
    const key = this.settings.musicKey;
    if (!key.stored) return this.fail(c, { code: "MUSIC_KEY_MISSING", detail: "no RapidAPI key is stored" });
    if (key.rejected) return this.fail(c, { code: "MUSIC_KEY_REJECTED", detail: "the stored RapidAPI key was rejected; replace it" });
    if (m.quotaLog === "held") return this.fail(c, { code: "MUSIC_UNAVAILABLE", musicReason: "log-held", detail: "the quota log could not be written (a result or key change is still held), so nothing was sent; try again later" });
    if (m.quotaLog === "corrupt") return this.fail(c, { code: "MUSIC_UNAVAILABLE", musicReason: "log-corrupt", detail: "the quota log has a line that cannot be read, so the request count cannot be trusted; nothing was sent" });
    if (m.quotaLog === "unreadable") return this.fail(c, { code: "MUSIC_UNAVAILABLE", musicReason: "log-unreadable", detail: "the quota log could not be read; nothing was sent" });
    if (m.quotaLog === "missing") return this.fail(c, { code: "MUSIC_UNAVAILABLE", musicReason: "log-missing", detail: "the quota log is gone although requests were sent before, so the request count cannot be trusted; nothing was sent" });
    const now = this.clock;
    const quota = mockQuota(m, now);
    if (quota.refusal !== null) {
      const when = quota.nextFreeAt === null ? "later" : new Date(quota.nextFreeAt).toISOString();
      return this.fail(c, {
        code: "MUSIC_QUOTA_EXHAUSTED",
        detail: quota.refusal === "quota" ? `${quota.sent} of ${MUSIC_QUOTA_LIMIT} requests were sent in the last 31 days; the next may leave at ${when}` : `flashapi's last answer said no requests remain; the next may leave at ${when}`,
      });
    }
    this.music = { ...m, sends: [...m.sends, now], refresh: { state: "running", done: 0, total: 1 } };
    this.emitMusic();
    this.scheduleMusicStep(0);
    return this.ok(c, { status: this.musicStatus() });
  }

  /** A refresh's next step on the mock's clock: the list request (with the server's figure), the downloads, then the new list. */
  private scheduleMusicStep(step: number): void {
    this.scheduler.schedule(this.stepMs, () => {
      const m = this.music;
      if (m.refresh.state !== "running") return;
      if (m.nextFailure !== null) {
        const error = m.nextFailure;
        this.music = { ...m, nextFailure: null, refresh: { state: "failed", error } };
        if (error.code === "MUSIC_KEY_REJECTED") this.rejectMusicKey();
        this.emitMusic();
        return;
      }
      const done = MOCK_MUSIC_STEPS[step];
      if (done === undefined) {
        this.music = { ...m, list: { fetchedAt: this.clock, ...MOCK_MUSIC_LIST }, tracks: demoTracks(MOCK_MUSIC_LIST.trackCount).map(mockTrack), refresh: { state: "idle" } };
        this.emitMusic();
        return;
      }
      // The list request answers first, with the server's own count of what is left.
      const serverRemaining = step === 0 ? { value: Math.max(0, MUSIC_QUOTA_LIMIT - mockQuota(m, this.clock).sent), at: this.clock } : m.serverRemaining;
      this.music = { ...m, serverRemaining, refresh: { state: "running", done, total: MOCK_MUSIC_TOTAL } };
      this.emitMusic();
      this.scheduleMusicStep(step + 1);
    });
  }

  /** `music.recoverQuotaLog {confirm: true}`: only a damaged or missing log, which becomes 30 sends made now. */
  private musicRecover(c: CommandMessage): ResponseMessage {
    const m = this.music;
    if (m.refresh.state === "running") return this.fail(c, { code: "IN_FLIGHT", detail: "a music refresh is running; recover the quota log once it has ended" });
    if (m.quotaLog === "unreadable") return this.fail(c, { code: "MUSIC_UNAVAILABLE", musicReason: "log-unreadable", detail: "the quota log could not be read, so nothing was changed" });
    if (m.quotaLog !== "corrupt" && m.quotaLog !== "missing") return this.fail(c, { code: "VALIDATION", detail: "the quota log is not damaged, so nothing was changed" });
    const now = this.clock;
    this.music = { ...m, quotaLog: "ok", sends: Array.from({ length: MUSIC_QUOTA_LIMIT }, () => now), serverRemaining: null };
    this.emitMusic();
    return this.ok(c, { status: this.musicStatus() });
  }

  private emitMusic(): void {
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "music.changed", payload: { status: this.musicStatus() } });
  }

  private emitSettingsChanged(): void {
    this.emit({
      v: PROTOCOL_VERSION,
      id: this.nextId("evt"),
      kind: "event",
      type: "settings.changed",
      payload: { settings: this.settings, librarySwitchGeneration: this.librarySwitchGeneration },
    });
  }

  private emitReconcileNeeded(): void {
    if (this.reconcileReasons.length === 0) return;
    this.emit({
      v: PROTOCOL_VERSION,
      id: this.nextId("evt"),
      kind: "event",
      type: "money.reconcileNeeded",
      payload: { reasons: this.reconcileReasons, unsettledMicros: this.unsettledMicros() },
    });
  }

  private emit(event: UnsequencedEvent): void {
    const seq = this.log.append(event);
    if (!this.delivering) return;
    const since = this.log.since(seq - 1, this.log.bootId);
    const delivered: EventMessage[] = since.gap ? [] : since.events;
    for (const e of delivered) for (const listener of [...this.listeners]) listener(e);
  }

  private bootId(): string {
    return `boot-${String(this.boot).padStart(4, "0")}`;
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${String(this.idCounter).padStart(4, "0")}`;
  }

  private nowIso(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
}

/** The mock as an `EngineClient`, through the same validating adapter as the real one; message ids count per client. */
export function mockEngineClient(engine: MockEngine = new MockEngine()): EngineClient {
  let messageCounter = 0;
  const client = createEngineClient(engine, "mock", () => `msg-${String(++messageCounter).padStart(6, "0")}`);
  // The dev build has no `studio-media://`: a text preview's PNG is handed to the window as a data URL, and a built-in
  // sticker as a stand-in of the mock's own.
  return { ...client, textPreviewUrl: (previewId) => pngDataUrl(engine.mockPreviewPng(previewId)), stickerUrl: mockStickerUrl };
}

function pngDataUrl(bytes: Uint8Array | null): string | null {
  if (bytes === null) return null;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

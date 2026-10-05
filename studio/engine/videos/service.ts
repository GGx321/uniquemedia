import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { FileState, VideoSummary, CommandPayload, EngineError, MediaKind, UnsequencedEvent } from "../../shared/engine";
import { EXPORT_CHANGING_DETAIL, MAX_LISTED_VIDEOS, PROTOCOL_VERSION, RENDER_NOT_QUEUED_DETAIL, renderQueueFullDetail } from "../../shared/engine";
import { draftCaptionIssues } from "../../shared/text/draftCaptionIssues";
import { MAX_MONTAGE_ISSUES, montageIssues, type MontageDraft, type MontageIssue } from "../../shared/engine/montage";
import { notYetSupportedIssues } from "../../shared/montage/notYetSupported";
import { ownPhotoCells, ownPhotoIssues } from "../../shared/montage/ownPhotos";
import { ownStickerCells, ownStickerIssues } from "../../shared/montage/ownStickers";
import { ownVideoClips, ownVideoIssues } from "../../shared/montage/ownVideos";
import { ownTrackIssues, trendingTrackIssues } from "../../shared/montage/trackIssues";
import type { RenderTrackSource } from "../music/renderTrack";
import { estimateBytesUpper } from "../../shared/montage";
import { resolveFocus } from "../../shared/montage/crop";
import { EngineFailure } from "../engineFailure";
import { safeName } from "../exportName";
import type { ExportRootCheck } from "../exportRoot";
import type { FocusResolver } from "../focus/focusResolver";
import type { MediaLookup } from "../media/service";
import { LibraryError, type Library } from "../library";
import { hasErrorCode } from "../library/durableFs";
import type { PhotoSource } from "../render";
import type { RenderQueue, RenderQueueEvent } from "../renderQueue/queue";
import { sweepRenderTmp } from "../renderQueue/sweep";
import { TEXT_PREVIEW_DIR } from "../text/preview";
import { stickerIssues } from "../../shared/stickers/stickerIssues";
import type { DraftStore } from "../montages/store";
import type { CommitFs } from "./commitFs";
import { deleteVideo, findVideoRecord, VideoDiskError, VideoFileUnreachableError, VideoNotFoundError, VideoRecordUnreadableError } from "./delete";
import { createRenderExecute, totalFramesOf, type RenderPlan, type SettleInput, type VideoRenderDeps } from "./execute";
import { ownPhotoCopyName, ownPhotoSourceOf, type OwnPhotoSource } from "./ownPhotos";
import { ownStickerSourceOf, type OwnStickerSource } from "./ownStickers";
import { ownTrackSourceOf, type OwnTrackSource } from "./ownTrack";
import { ownVideoSourceOf, type OwnVideoSource } from "./ownVideos";
import { newHashBudget, type FileStateChecker } from "./fileState";
import type { LayerDeps } from "./layers";
import { readVideoRecordFile, readVideoRecordFiles, videoSummaryOf } from "./listing";
import type { CommitTracker, LiveCommits } from "./live";
import { scenePhotoIds, videoPaths, type VideoRecord } from "./record";
import { recoverVideos, type ExportRootRef, type RecoverDeps } from "./recovery";
import { CASE_PROBE_TIMEOUT_MS, DELETE_TIMEOUT_MS, LIST_BUDGET_MS, RECORD_CHECK_TIMEOUT_MS } from "./timeouts";

// The command layer of the video pipeline (Stage 3 plan, 3a.8b.2): `videos.render`, `videos.cancel`, `videos.list` and
// `videos.delete`, the render queue's events as the contract's `job.*` and `video.changed`, and what happens around a
// library opening (recovery) and the engine stopping. The engine wires it; every disk, the queue, the focus resolver
// and the export check come in as dependencies, so each mapping is tested with a fake.
//
// `videos.render` is ONE step before `submit`, and nothing is claimed, reserved or written until `submit` answers ok:
//   1. the spec's structure, N9, the built-in stickers it names, the captions the shared rules refuse and a trending track against the store (no disk);
//   2. the export folder, checked afresh (invariant 35), its marker's id going into the plan; then the avatar (active only);
//   3. eligibility and used (invariant 18) through the library's own refusal-aware function, BEFORE any focus work;
//   4. the focus is filled, under what is left of the command's own deadline;
//   5. eligibility again, synchronously, then the photos' files and stored sizes, then `submit`, with no await between
//      them: a photo rejected or taken while the focus was being computed is caught, and the reservation `submit` makes
//      closes the window for the next render.
// From the avatar on, the step runs as a counted write on the library (`withLibrary`): a library switch is REFUSED
// (IN_FLIGHT) while it runs, and while any render is queued or running. (The export check is asked first, in the
// validation's own tick, so attempts made together share one check.)
// The whole command has a deadline of its own, under main's 30 s: a request main has already answered with a timeout
// must never go on to queue a job the window does not know about.

/** Renders the queue holds and the window may be told about; see `RenderQueueEvent`. */
export type VideoQueue = Pick<RenderQueue, "submit" | "cancel" | "states" | "idle" | "holdMedia">;

/** Timers the background work uses, injected so tests control time. */
export interface ServiceTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface VideoServiceDeps {
  readonly queue: VideoQueue;
  /** The live commits: the SAME instance every render's `execute` registers in, and recovery reads. */
  readonly tracker: CommitTracker;
  readonly checker: FileStateChecker;
  /** Runs `work` with the live library, counted as a write so a library switch cannot land inside it; throws the engine's own refusal (LIBRARY_UNAVAILABLE, IN_FLIGHT) when there is none. */
  readonly withLibrary: <T>(work: (library: Library) => Promise<T>) => Promise<T>;
  /** The open library, unchecked (reads only); null when none. */
  readonly openLibrary: () => Library | null;
  /** A FRESH check of the export folder (its marker read now, never a snapshot). With `requiredBytes` it also wants twice that free. Never rejects. */
  readonly checkExport: (requiredBytes?: number) => Promise<ExportRootCheck>;
  /**
   * The export folder's switch (3e.3), asked right before a render is submitted: `pending` while the owner's pick has been
   * answered and its `settings.update` has not arrived, `currentPath` the folder the settings name now. Absent, no render is held.
   */
  readonly exportSwitch?: { pending(): boolean; currentPath(): string };
  /**
   * The montage drafts: `videos.render {montageId}` reads its spec from here, a video's record stops naming a draft that was
   * deleted, and so does `videos.list`. Absent: a `montageId` is NOT_FOUND, as before drafts existed.
   */
  readonly drafts?: Pick<DraftStore, "find" | "exists" | "wasRemoved" | "exclusive">;
  readonly caseProbe: { isCaseInsensitive(root: string): Promise<boolean> };
  /** The focus resolver of `library`; `fillMissingFocus` takes a budget for the call (cells judged by then are kept) and a signal that ends it early. */
  readonly focus: (library: Library) => Pick<FocusResolver, "fillMissingFocus">;
  /** `userData/render-tmp`; a render is refused without it (no `os.tmpdir` fallback). */
  readonly renderTmpDir: string | undefined;
  /** The text rasteriser and the verified sticker set, for the layers of a spec (3b.6). Absent, a spec with layers fails its job INTERNAL. */
  readonly layers?: LayerDeps;
  /**
   * The track store (3c.5): `videos.render` judges a trending track against its record up front (`trackIssues`), and the job
   * opens it through it when it starts. Absent: no track is held, so a spec with music is refused as `track-unavailable`.
   */
  readonly tracks?: RenderTrackSource;
  /**
   * The own media (3f.2 photos, 3f.3b videos, 3f.4 music, 3f.5 stickers): `videos.render` looks each own photo of a spec up as a PHOTO, each own video clip's media
   * as a VIDEO, each own sticker as a STICKER and its own track as an AUDIO media (`MediaService.lookup`) and reserves each on the queue in the same step; the job
   * copies a photo or sticker, verified, into its own folder, STREAMS a video's mezzanine in the same way and reads the track's verified bytes. Absent: no own media is held, so a spec that names one is refused as
   * `media-unavailable`.
   */
  readonly media?: { lookup(mediaId: string, kind: MediaKind, onFound?: (found: MediaLookup) => void): Promise<MediaLookup | undefined> };
  readonly newId: () => string;
  readonly now: () => Date;
  readonly emit: (event: UnsequencedEvent) => void;
  /** Tells the windows an avatar's counts moved (`avatar.changed`): its `eligibleUnusedCount` and `videoCount`. Never throws. */
  readonly announceAvatar: (library: Library, avatarId: string) => void;
  /** Codes, ids and counts only: never a path, a message or a file's text. */
  readonly log: (line: string) => void;
  readonly fs?: CommitFs;
  /** Test seams of the render itself (ffmpeg, the verifier, the commit's steps, its deadlines). */
  readonly renderOverrides?: Partial<Pick<VideoRenderDeps, "fs" | "folderFs" | "runJob" | "runDeps" | "verify" | "hooks" | "claimStartAt" | "commitDeadlineMs" | "stepDeadlineMs" | "createTemp" | "inspectStreams" | "ownVideoIo" | "numberFs">>;
  readonly recover?: { readonly run?: typeof recoverVideos; readonly deps?: RecoverDeps };
  /** Waits before each background retry of a stale used index; `DEFAULT_STALE_RETRY_DELAYS_MS` when absent. The last delay repeats until the index is in step. */
  readonly staleRetryDelaysMs?: readonly number[];
  readonly timers?: ServiceTimers;
  /** From entry to `videos.render` to its answer; `RENDER_COMMAND_DEADLINE_MS` when absent. */
  readonly commandDeadlineMs?: number;
  /** What `videos.render` keeps back from that deadline for the rest of its work after the focus; `RENDER_COMMAND_MARGIN_MS` when absent. */
  readonly commandMarginMs?: number;
  /** How long a `videos.delete`'s disk work may take; `DELETE_TIMEOUT_MS` when absent. */
  readonly deleteTimeoutMs?: number;
  /** How long one record's file check may take in a listing; `RECORD_CHECK_TIMEOUT_MS` when absent. */
  readonly recordCheckTimeoutMs?: number;
  /** The one budget of a whole `videos.list`, from its entry; `LIST_BUDGET_MS` when absent. */
  readonly listBudgetMs?: number;
  /** How long the probe of the export volume's case rule may take in `#freshRoot`; `CASE_PROBE_TIMEOUT_MS` when absent. */
  readonly caseProbeTimeoutMs?: number;
  /** How the commit intent's file is looked at before a settle; `lstat` when absent (a test plays a disk that fails or does not answer). */
  readonly intentLstat?: (path: string) => Promise<unknown>;
  /** How the records of an avatar are read for a listing; `readVideoRecordFiles` when absent (a test plays a library disk that does not answer). */
  readonly readRecordFiles?: typeof readVideoRecordFiles;
}

/** Waits before the background retries of a stale used index; the last one repeats until the records are read. */
export const DEFAULT_STALE_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 60_000];
/** Under main's 30 s command deadline (`REQUEST_TIMEOUT_MS`), with room for the answer to travel. */
export const RENDER_COMMAND_DEADLINE_MS = 25_000;
/** Kept back for eligibility, the sources and `submit` once the focus is done. */
export const RENDER_COMMAND_MARGIN_MS = 2_000;
export { DELETE_TIMEOUT_MS, RECORD_CHECK_TIMEOUT_MS };
/** How long after the focus budget the abort net waits. */
const FOCUS_NET_SLACK_MS = 25;
/** Reading the used index again on demand before a render or a list. */
const STALE_RELOAD_BOUND_MS = 5_000;

function realTimers(): ServiceTimers {
  const live = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 0;
  return {
    set: (fn, ms) => {
      const id = ++next;
      const timer = setTimeout(() => {
        live.delete(id);
        fn();
      }, ms);
      // A background retry must never keep the engine alive.
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      live.set(id, timer);
      return id;
    },
    clear: (handle) => {
      if (typeof handle !== "number") return;
      const timer = live.get(handle);
      if (timer !== undefined) clearTimeout(timer);
      live.delete(handle);
    },
  };
}

// ---------- pure parts ----------

/** The kind token of the file name: `photo` for photo clips only, a collage's layout when every clip is a collage of it, else `mix`. */
export function videoKindOf(clips: readonly { readonly kind: string; readonly layout?: string }[]): string {
  if (clips.every((clip) => clip.kind === "photo")) return "photo";
  const layouts = new Set(clips.map((clip) => (clip.kind === "collage" ? clip.layout : undefined)));
  const [only] = [...layouts];
  return layouts.size === 1 && only !== undefined ? only : "mix";
}

/** What a render starts from: a headless spec, or a saved draft's spec with the draft's id and the library it was read from. */
interface RenderSource {
  readonly montageId: string | null;
  /** The draft's name as it was read (K12): the record keeps it. Null for an unnamed draft and a headless spec. */
  readonly title: string | null;
  readonly spec: MontageDraft;
  readonly library: Library | null;
}

interface SceneCell {
  readonly photoId: string;
  readonly path: (string | number)[];
}

/** Every scene-photo cell of a spec, in order, with where it is (the issue's path). */
function sceneCells(spec: Pick<MontageDraft, "clips">): SceneCell[] {
  const cells: SceneCell[] = [];
  spec.clips.forEach((clip, i) => {
    if (clip.kind === "photo") {
      if (clip.cell.photo?.source === "scene") cells.push({ photoId: clip.cell.photo.photoId, path: ["clips", i, "cell"] });
    } else if (clip.kind === "collage") {
      clip.cells.forEach((cell, j) => {
        if (cell.photo?.source === "scene") cells.push({ photoId: cell.photo.photoId, path: ["clips", i, "cells", j] });
      });
    }
  });
  return cells;
}

/** `spec` with every null focus set to the stand-in point: what a render uses when the focus could not be judged in time. */
function withStandInFocus(spec: MontageDraft): MontageDraft {
  const fill = <C extends { focus: { x: number; y: number } | null }>(cell: C): C => ({ ...cell, focus: cell.focus ?? resolveFocus(null) });
  const clips = spec.clips.map((clip) => {
    if (clip.kind === "photo") return { ...clip, cell: fill(clip.cell) };
    if (clip.kind === "collage") return { ...clip, cells: clip.cells.map(fill) };
    return { ...clip, focus: clip.focus ?? resolveFocus(null) };
  });
  return { ...spec, clips };
}

function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "error";
}

/** What may be logged of an error: its class or errno code. Never its message (it may name the owner's paths). */
function kindOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return "code" in error && typeof error.code === "string" ? error.code : error.name;
}

const unavailable = (cells: readonly SceneCell[], detail?: string): EngineFailure =>
  new EngineFailure({ code: "PHOTO_UNAVAILABLE", issues: cells.slice(0, MAX_MONTAGE_ISSUES).map((cell) => ({ code: "photo-unavailable", path: cell.path })), ...(detail === undefined ? {} : { detail }) });

/** `work`, or `onTimeout()` once `ms` have passed (at once for `ms <= 0`); `work` itself is never cancelled. */
async function within<T>(ms: number, work: () => Promise<T>, onTimeout: () => Error): Promise<T> {
  if (ms <= 0) throw onTimeout();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  late.catch(() => undefined);
  try {
    return await Promise.race([work(), late]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- the service ----------

export class VideoService {
  readonly #deps: VideoServiceDeps;
  readonly #timers: ServiceTimers;
  #closing = false;
  #preparing = 0;
  /** Startup, recovery and settle work in the background. Never awaited by a command or by the library opening. */
  readonly #tasks = new Set<Promise<void>>();
  /** One controller per library whose recovery may still be running: a switch aborts every other one. */
  readonly #recoveries = new Map<Library, AbortController>();
  /** One retry chain per avatar whose used index is stale: the timer handle of its next attempt. */
  readonly #staleChains = new Map<string, unknown>();

  constructor(deps: VideoServiceDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? realTimers();
  }

  // ---------- videos.render ----------

  /** Renders that are being prepared: the export folder is in their plan, but nothing is queued yet (`active()` of the queue does not see them). */
  get preparing(): number {
    return this.#preparing;
  }

  async render(payload: CommandPayload<"videos.render">): Promise<{ jobId: string; videoId: string }> {
    // Counted from the first line to the last: a switch of the export folder must not slip in while the focus of the photos is
    // judged (up to 15 s), after the folder was resolved into the plan and before the job is submitted.
    this.#preparing++;
    try {
      return await this.#prepareAndSubmit(payload);
    } finally {
      this.#preparing--;
    }
  }

  async #prepareAndSubmit(payload: CommandPayload<"videos.render">): Promise<{ jobId: string; videoId: string }> {
    const entered = performance.now();
    const budgetMs = this.#deps.commandDeadlineMs ?? RENDER_COMMAND_DEADLINE_MS;
    const marginMs = this.#deps.commandMarginMs ?? RENDER_COMMAND_MARGIN_MS;
    const remaining = (): number => budgetMs - (performance.now() - entered);
    if (this.#closing) throw new EngineFailure({ code: "INTERNAL", detail: "the engine is shutting down" });
    // A saved draft is read first: its spec is what everything after judges, and a draft that is gone or unreadable
    // refuses before the export folder or anything else is looked at. The job keeps THIS copy: a save or a delete after
    // it does not reach the render.
    const source: RenderSource = "montageId" in payload ? await this.#loadDraft(payload.montageId) : { montageId: null, title: null, spec: payload.spec, library: null };
    const { spec } = source;
    // The read waited in the draft's queue: whatever it used of the command's time is gone, so out of time is said as that.
    if (source.library !== null && remaining() <= marginMs) throw new EngineFailure({ code: "INTERNAL", detail: RENDER_NOT_QUEUED_DETAIL });
    // In the order `montages.get` reports them: structure, what has not landed (N9), the stickers the set lacks, the captions that break the rules, the music track.
    const issues = [...montageIssues(spec, "spec"), ...notYetSupportedIssues(spec), ...stickerIssues(spec), ...draftCaptionIssues(spec), ...this.#trackIssues(spec)].slice(0, MAX_MONTAGE_ISSUES);
    if (issues.length > 0) throw new EngineFailure({ code: "MONTAGE_INVALID", issues });
    const renderTmpDir = this.#deps.renderTmpDir;
    if (renderTmpDir === undefined) throw new EngineFailure({ code: "INTERNAL", detail: "no render folder is configured, so nothing can be rendered" });
    // 3f.2, 3f.3b, 3f.4, 3f.5: the own photos, videos, stickers and track the spec names are looked up and RESERVED here, each in the step that finds it
    // (MediaService.lookup's onFound), so `media.delete` of one is refused IN_FLIGHT from that moment. The holds are given back whatever happens
    // below: `submit` takes over with the queue's own reservation, and a refusal leaves nothing held.
    const admission = await this.#admitOwnMedia(spec);
    try {
      // Invariant 35: the export folder, checked NOW, before anything else about the render is looked at (a spec that is
      // valid in shape gets this answer whatever else is wrong with it); its marker's id is the one the job commits against.
      // Asked in the same tick as the validation, so attempts made together share one check (a mute drive costs one timeout).
      const check = await within(
        remaining(),
        () => this.#deps.checkExport(estimateBytesUpper(spec.clips)),
        () => new EngineFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", detail: "the export folder did not answer in time" }),
      );
      if (!check.ok) throw new EngineFailure({ code: "EXPORT_UNAVAILABLE", exportReason: check.reason });
      return await this.#deps.withLibrary((library) => {
        // The draft was read from the library that was open then; a render is queued in the one that is open now.
        if (source.library !== null && source.library !== library) throw new EngineFailure({ code: "NOT_FOUND", detail: `no montage draft ${source.montageId} in the open library` });
        // The own media were found in the library that was open when they were looked up: another one now holds none of them.
        if ((admission.photos.size + admission.videos.size + admission.stickers.size > 0 || admission.track !== null) && admission.library !== library) throw new EngineFailure({ code: "IN_FLIGHT", detail: "the library was switched while the render was being prepared" });
        return this.#render(library, spec, source, renderTmpDir, check, admission.photos, admission.videos, admission.stickers, admission.track, { remaining, marginMs });
      });
    } finally {
      admission.release();
    }
  }

  /**
   * The own media of `spec`: each own photo looked up as a PHOTO, each own video clip's media as a VIDEO, each own sticker as a STICKER and the own track as an AUDIO
   * media, each held on the queue in the same step that finds it (`onFound` runs inside the lookup, so there is no await between the two, and `media.delete` takes a media out
   * of lookup in its first tick before it asks the reserved provider: a media is either found here and then refused to the delete, or not found). A
   * media that two cells, clips or layers use is looked up once. One that is not there (or is another kind, or not one the render can read) is
   * `media-unavailable` at each of its places (the photos' first, in clip order, then the video clips', then the stickers', in layer order, then the music); a video
   * clip that asks past its video's end is `video-too-short` and a track too short for `startMs` plus the montage is `track-too-short`: every hold already made is
   * given back and the render is refused. `release` gives the
   * holds back; calling it again changes nothing.
   */
  async #admitOwnMedia(
    spec: MontageDraft,
  ): Promise<{ photos: Map<string, OwnPhotoSource>; videos: Map<string, OwnVideoSource>; stickers: Map<string, OwnStickerSource>; track: OwnTrackSource | null; library: Library | null; release: () => void }> {
    const photos = new Map<string, OwnPhotoSource>();
    const videos = new Map<string, OwnVideoSource>();
    const stickers = new Map<string, OwnStickerSource>();
    const admitted: { track: OwnTrackSource | null } = { track: null };
    const holds: (() => void)[] = [];
    const release = (): void => {
      for (const hold of holds.splice(0)) hold();
    };
    const photoCells = ownPhotoCells(spec);
    const videoClips = ownVideoClips(spec);
    const stickerCells = ownStickerCells(spec);
    const music = spec.music?.source === "own" ? spec.music : null;
    if (photoCells.length + videoClips.length + stickerCells.length === 0 && music === null) return { photos, videos, stickers, track: null, library: null, release };
    const library = this.#deps.openLibrary();
    const media = this.#deps.media;
    try {
      const askedPhotos = new Set<string>();
      for (const { mediaId } of photoCells) {
        if (askedPhotos.has(mediaId)) continue;
        askedPhotos.add(mediaId);
        if (media === undefined) continue;
        await media.lookup(mediaId, "photo", (found) => {
          // Synchronously, in the lookup's own step: the hold and the record it is a hold of.
          const source = ownPhotoSourceOf(found);
          if (source === null) return;
          holds.push(this.#deps.queue.holdMedia(mediaId));
          photos.set(mediaId, source);
        });
      }
      const askedVideos = new Set<string>();
      for (const { mediaId } of videoClips) {
        if (askedVideos.has(mediaId)) continue;
        askedVideos.add(mediaId);
        if (media === undefined) continue;
        await media.lookup(mediaId, "video", (found) => {
          // The same step, for a video.
          const source = ownVideoSourceOf(found);
          if (source === null) return;
          holds.push(this.#deps.queue.holdMedia(mediaId));
          videos.set(mediaId, source);
        });
      }
      const askedStickers = new Set<string>();
      for (const { mediaId } of stickerCells) {
        if (askedStickers.has(mediaId)) continue;
        askedStickers.add(mediaId);
        if (media === undefined) continue;
        await media.lookup(mediaId, "sticker", (found) => {
          // The same step, for a sticker.
          const source = ownStickerSourceOf(found);
          if (source === null) return;
          holds.push(this.#deps.queue.holdMedia(mediaId));
          stickers.set(mediaId, source);
        });
      }
      if (music !== null && media !== undefined) {
        await media.lookup(music.mediaId, "audio", (found) => {
          const source = ownTrackSourceOf(found);
          if (source === null) return;
          holds.push(this.#deps.queue.holdMedia(music.mediaId));
          admitted.track = source;
        });
      }
      const held = admitted.track;
      const issues = [
        ...ownPhotoIssues(spec, (mediaId) => photos.has(mediaId)),
        ...ownVideoIssues(spec, (mediaId) => videos.get(mediaId) ?? null),
        ...ownStickerIssues(spec, (mediaId) => stickers.has(mediaId)),
        ...ownTrackIssues(spec, (mediaId) => (held !== null && held.mediaId === mediaId ? { durationMs: held.durationMs } : null)),
      ];
      if (issues.length > 0) throw new EngineFailure({ code: "MONTAGE_INVALID", issues: issues.slice(0, MAX_MONTAGE_ISSUES) });
    } catch (error) {
      release();
      throw error;
    }
    return { photos, videos, stickers, track: admitted.track, library, release };
  }

  /**
   * A saved draft's spec, with the library it was read from. NOT_FOUND for a draft that is not there, INTERNAL for one that
   * cannot be read (its detail names no path). The read runs in the DRAFT'S OWN queue (`exclusive`), entered synchronously
   * when the command arrives: a save asked before this render is applied first, so the render never reads an older draft
   * and reserves photos the owner has just replaced. Only the read is queued; the job keeps that copy.
   */
  #loadDraft(montageId: string): Promise<RenderSource> {
    const drafts = this.#deps.drafts;
    if (drafts === undefined) return Promise.reject(new EngineFailure({ code: "NOT_FOUND", detail: `no montage draft ${montageId}: drafts are not available` }));
    return drafts.exclusive(montageId, async () => {
      const library = this.#deps.openLibrary();
      if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
      const found = await drafts.find(library, montageId);
      if (found === null || found.read.kind === "missing") throw new EngineFailure({ code: "NOT_FOUND", detail: `no montage draft ${montageId}` });
      if (found.read.kind === "unreadable") {
        this.#deps.log(`videos.render: a montage draft could not be used (${found.read.reason})`);
        throw new EngineFailure({ code: "INTERNAL", detail: `the montage draft cannot be read (${found.read.reason})` });
      }
      return { montageId, title: found.read.montage.name, spec: found.read.montage.spec, library };
    });
  }

  /**
   * A trending track's referential issues (`track-unavailable`, `track-too-short`): the one function the mock and `montages.get` use too. An own track is
   * judged later, by the admission (`ownTrackIssues`), which is the step that looks it up.
   */
  #trackIssues(spec: MontageDraft): MontageIssue[] {
    const tracks = this.#deps.tracks;
    return trendingTrackIssues(spec, tracks === undefined ? undefined : (trackId) => tracks.stored(trackId));
  }

  async #render(
    library: Library,
    spec: MontageDraft,
    source: Pick<RenderSource, "montageId" | "title">,
    renderTmpDir: string,
    check: Extract<ExportRootCheck, { ok: true }>,
    ownPhotos: ReadonlyMap<string, OwnPhotoSource>,
    ownVideos: ReadonlyMap<string, OwnVideoSource>,
    ownStickers: ReadonlyMap<string, OwnStickerSource>,
    ownTrack: OwnTrackSource | null,
    time: { remaining(): number; marginMs: number },
  ): Promise<{ jobId: string; videoId: string }> {
    const deps = this.#deps;
    const { montageId } = source;
    const outOfTime = (): EngineFailure => new EngineFailure({ code: "INTERNAL", detail: RENDER_NOT_QUEUED_DETAIL });
    if (time.remaining() <= time.marginMs) throw outOfTime();
    const avatar = library.getAvatar(spec.avatarId);
    // Only an ACTIVE avatar renders: a draft has no scene photos, and an archived one is retired: rendering makes new
    // content, which photo runs refuse for it too. Its existing videos still list and delete.
    if (avatar === undefined || avatar.status !== "active") throw new EngineFailure({ code: "NOT_FOUND", detail: `no active avatar ${spec.avatarId} in the open library` });

    const cells = sceneCells(spec);
    await this.#readIndexAgain(library, spec.avatarId);
    this.#assertAvailable(library, spec.avatarId, cells);

    let filled: MontageDraft;
    const focusMs = time.remaining() - time.marginMs;
    if (focusMs <= 0) throw outOfTime();
    const spent = new AbortController();
    // The resolver gets what is left as its own budget: it stops starting cells when that runs low and keeps every cell it
    // has judged. The abort is only the net under a resolver that does not keep to it (a little later, so it never wins).
    const timer = setTimeout(() => spent.abort(new Error("the focus budget of this render is spent")), focusMs + FOCUS_NET_SLACK_MS);
    try {
      const result = await deps.focus(library).fillMissingFocus(spec, spent.signal, { budgetMs: focusMs });
      filled = result.spec;
      if (result.unresolved.length > 0) deps.log(`videos.render: ${result.unresolved.length} photo(s) could not be judged for their focus; the stand-in point is used`);
    } catch (error) {
      if (spent.signal.aborted) {
        // What is left of the command's time is spent: the stand-in point, as for a photo that could not be judged.
        deps.log("videos.render: the focus budget ran out; the stand-in point is used for what was not judged");
        filled = withStandInFocus(spec);
      } else if (error instanceof LibraryError && error.code === "photo-not-found") throw unavailable(cells);
      else throw error;
    } finally {
      clearTimeout(timer);
    }

    // From here to `submit` nothing is awaited.
    if (time.remaining() <= 0) throw outOfTime();
    this.#assertAvailable(library, spec.avatarId, cells);
    if (this.#closing) throw new EngineFailure({ code: "INTERNAL", detail: "the engine is shutting down" });
    // The folder the plan is about to name must still be the export folder, and none may be being switched: a render that commits
    // into the old folder after the owner was told «nothing is left behind» would be lost with the folder they then clear out.
    const exportSwitch = deps.exportSwitch;
    if (exportSwitch !== undefined && (exportSwitch.pending() || check.root !== exportSwitch.currentPath())) {
      throw new EngineFailure({ code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL });
    }
    const sources = new Map<string, PhotoSource>();
    for (const cell of cells) {
      const sidecar = library.getPhoto(cell.photoId);
      const path = library.photoFilePath(cell.photoId);
      if (sidecar === undefined || path === undefined) throw unavailable(cells.filter((c) => c.photoId === cell.photoId));
      // The STORED size: what the sidecar reports (the graph reads the file with -noautorotate).
      sources.set(cell.photoId, { path, width: sidecar.width, height: sidecar.height });
    }

    const jobId = deps.newId();
    const videoId = deps.newId();
    const plan: RenderPlan = {
      jobId,
      videoId,
      avatarId: spec.avatarId,
      safeName: safeName(avatar.name, avatar.id),
      exportRoot: { root: check.root, rootId: check.rootId },
      spec: filled,
      // An own photo resolves to its PRIVATE COPY in this job's folder (the runner writes it, checked, before any ffmpeg): the library file is
      // never an ffmpeg input. The size is the stored JPEG's own (already upright).
      resolvePhoto: (ref) => {
        if (ref.source === "scene") return sources.get(ref.photoId);
        const own = ownPhotos.get(ref.mediaId);
        return own === undefined ? undefined : { path: join(renderTmpDir, jobId, ownPhotoCopyName(own.mediaId)), width: own.width, height: own.height };
      },
      ownPhotos: [...ownPhotos.values()],
      scenePhotoBytes: scenePhotoIds(filled.clips).reduce((sum, id) => sum + (library.getPhoto(id)?.bytes ?? 0), 0),
      // An own video clip: the mezzanine as the admission found it; the job streams a verified copy into its own folder, the library file is never an ffmpeg input.
      ownVideos: [...ownVideos.values()],
      ownStickers: [...ownStickers.values()],
      audio: { kind: "silent" },
      // The id and the start only: the file's path comes from the track store when the job runs (invariant 31).
      ...(filled.music?.source === "trending" ? { track: { trackId: filled.music.trackId, startMs: filled.music.startMs } } : {}),
      // An own track: the stored file as the admission found it; the job reads its verified bytes, the library file is never an ffmpeg input.
      ...(filled.music?.source === "own" && ownTrack !== null ? { ownTrack: { source: ownTrack, startMs: filled.music.startMs } } : {}),
      montageId,
      title: source.title,
      videoKind: videoKindOf(filled.clips),
      music: null,
    };
    const execute = createRenderExecute({
      library,
      tracker: deps.tracker,
      renderTmpDir,
      caseProbe: deps.caseProbe,
      now: deps.now,
      log: deps.log,
      ...(deps.tracks === undefined ? {} : { tracks: deps.tracks }),
      onCommitted: (record) => this.#committed(record),
      ...(deps.layers === undefined ? {} : { layers: deps.layers }),
      ...(deps.drafts === undefined ? {} : { draftRemoved: (id: string) => deps.drafts?.wasRemoved(id) === true }),
      // A commit that fails and leaves its intent is settled inside the job, before it ends (the reservation still held).
      settleLeftover: (input, signal) => this.#settleLeftover(library, input, signal),
      ...deps.renderOverrides,
    });
    // ONE number of frames: the queue's total, and the verifier's expectation (execute), come from the same function.
    const result = deps.queue.submit({
      jobId,
      ref: { videoId, avatarId: spec.avatarId, montageId },
      totalFrames: totalFramesOf(filled.clips),
      photoIds: scenePhotoIds(filled.clips),
      mediaIds: [...ownPhotos.keys(), ...ownVideos.keys(), ...ownStickers.keys(), ...(ownTrack === null ? [] : [ownTrack.mediaId])],
      execute: execute(plan),
    });
    if (!result.ok) {
      if (result.code === "QUEUE_FULL") throw new EngineFailure({ code: "RENDER_QUEUE_FULL", detail: renderQueueFullDetail(result.limit) });
      const held = new Set(result.photoIds);
      throw unavailable(cells.filter((cell) => held.has(cell.photoId)), "another render that is queued or running holds this photo");
    }

    // A render that has to wait is announced now; one that started already was, by its `started` event.
    const state = deps.queue.states().find((s) => s.jobId === jobId);
    if (state?.kind === "render" && state.status === "queued") this.#emitProgress(state);
    // The photos are reserved now: the avatar's `eligibleUnusedCount` moved.
    this.#announce(library, spec.avatarId);
    return { jobId, videoId };
  }

  /**
   * The used index is behind the disk (`index-stale`: a commit's index update failed and could not be rebuilt): read the
   * records again NOW, bounded, before the avatar is judged. The background retries are the fallback, not the way.
   */
  async #readIndexAgain(library: Library, avatarId: string): Promise<void> {
    if (library.videoIndexStale(avatarId).length === 0) return;
    try {
      await within(STALE_RELOAD_BOUND_MS, () => library.reloadVideoRecords(avatarId), () => new Error("timeout"));
    } catch (error) {
      this.#deps.log(`the used index of avatar ${avatarId} could not be read again (${kindOf(error)})`);
    }
  }

  /**
   * Eligibility and used for every scene cell, through the library's own refusal-aware function (`eligibleUnusedPhotos`:
   * it throws while the avatar's usage cannot be trusted; `photoStates` and `isEligible` know nothing of that).
   */
  #assertAvailable(library: Library, avatarId: string, cells: readonly SceneCell[]): void {
    let free: Set<string>;
    try {
      free = new Set(library.eligibleUnusedPhotos(avatarId).map((photo) => photo.id));
    } catch (error) {
      if (error instanceof LibraryError) {
        if (error.code === "library-too-new") throw new EngineFailure({ code: "LIBRARY_TOO_NEW", detail: "a video record of this avatar was written by a newer version of Studio" });
        if (error.code === "index-stale" || error.code === "log-needs-repair") {
          // The library's message names a record file; the code is what the owner's window may be told.
          throw unavailable(cells, `the usage of this avatar's photos cannot be trusted right now (${error.code})`);
        }
      }
      throw error;
    }
    const missing = cells.filter((cell) => !free.has(cell.photoId));
    if (missing.length > 0) throw unavailable(missing);
  }

  // ---------- videos.cancel ----------

  /** Render jobs only: any other id (an avatar job, an unknown one) is NOT_FOUND. A cancel past the commit's point of no return is ignored by the commit, so the answer is still ok and the job ends `done`. */
  cancel(jobId: string): { jobId: string } {
    if (!this.#deps.queue.cancel(jobId)) throw new EngineFailure({ code: "NOT_FOUND", detail: `no render job ${jobId}` });
    return { jobId };
  }

  // ---------- videos.list ----------

  async list(avatarId: string): Promise<VideoSummary[]> {
    const enteredAt = performance.now();
    const listBudgetMs = this.#deps.listBudgetMs ?? LIST_BUDGET_MS;
    const library = this.#deps.openLibrary();
    if (library?.getAvatar(avatarId) === undefined) throw new EngineFailure({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    await this.#readIndexAgain(library, avatarId);
    let read;
    try {
      // The library's disk is under the same budget: a read that never returns ends the list with the engine's own error, not main's NO_ANSWER.
      read = await within(
        listBudgetMs - (performance.now() - enteredAt),
        () => (this.#deps.readRecordFiles ?? readVideoRecordFiles)(library.root, avatarId),
        () => Object.assign(new Error("the records read did not answer"), { code: "ETIMEDOUT" }),
      );
    } catch (error) {
      // A raw fs error names the library's absolute path, which `maskHome` cannot know for `/Volumes` or `/var`: only the code is told.
      this.#deps.log(`videos.list: the records of avatar ${avatarId} could not be read (${kindOf(error)})`);
      throw new EngineFailure({ code: "INTERNAL", detail: `the video records could not be read (${codeOf(error)})` });
    }
    if (read.skipped > 0) this.#deps.log(`videos.list: ${read.skipped} record file(s) of avatar ${avatarId} could not be used and are left out`);
    if (read.truncated) this.#deps.log(`videos.list: avatar ${avatarId} has more record files than one listing reads; the newest are listed`);
    // One fresh look at the export root, one hash budget for the whole listing.
    // The look at the export root is inside the listing's budget too: a root that does not answer is "cannot judge" (null), and every record reads `unchecked`.
    let root: ExportRootRef | null = null;
    // A root that could not be judged in time says nothing about any file (K15): every record reads `unchecked`, never «elsewhere» (which is what a refused root says).
    let rootJudged = true;
    try {
      root = await within(listBudgetMs - (performance.now() - enteredAt), () => this.#freshRoot(), () => Object.assign(new Error("the export root check did not answer"), { code: "ETIMEDOUT" }));
    } catch (error) {
      rootJudged = false;
      this.#deps.log(`videos.list: the export folder could not be looked at in time (${kindOf(error)}); the files are left unchecked`);
    }
    const budget = newHashBudget();
    const checkMs = this.#deps.recordCheckTimeoutMs ?? RECORD_CHECK_TIMEOUT_MS;
    const summaries: VideoSummary[] = [];
    const drafts = new Map<string, boolean>();
    let spentLogged = false;
    /** A look that was cut at what the budget had left: the budget is spent, whatever the clock says to the millisecond. */
    let cutByBudget = false;
    for (const record of read.records.slice(0, MAX_LISTED_VIDEOS)) {
      let state: FileState;
      // The listing's own budget, from its entry: a record looked at after it is spent is `unchecked` without a call to the disk, and one in flight is cut at what is left.
      const remainingMs = listBudgetMs - (performance.now() - enteredAt);
      if (!rootJudged || remainingMs <= 0) {
        if (!spentLogged) this.#deps.log(`videos.list: the listing's budget of ${listBudgetMs} ms is spent; the remaining files of avatar ${avatarId} are left unchecked`);
        spentLogged = true;
        state = "unchecked";
      } else {
        try {
          state = await within(Math.min(checkMs, remainingMs), () => this.#deps.checker.check(record, root, { verify: "cheap", budget }), () => Object.assign(new Error("the file check did not answer"), { code: "ETIMEDOUT" }));
        } catch (error) {
          // A look that failed is `unchecked` (K15): not a claim that the file is gone or in another folder, and not a failed list.
          this.#deps.log(`videos.list: the file of ${record.id} could not be checked (${kindOf(error)})`);
          if (remainingMs <= checkMs) cutByBudget = true;
          state = "unchecked";
        }
      }
      // The draft lookups are disk calls too: once the budget is spent the record keeps the draft id as written (the same answer as a lookup that failed).
      const spent = cutByBudget || performance.now() - enteredAt >= listBudgetMs;
      summaries.push(videoSummaryOf(spent ? record : await this.#withLiveDraft(library, record, drafts), state));
    }
    return summaries;
  }

  // ---------- videos.get ----------

  /**
   * One video by id (3e.2), with its file looked at now, as `videos.list` would show it: main's «Открыть в папке» reads its
   * place through this, for any video of any avatar, without a listing (which stops at MAX_LISTED_VIDEOS). The record is found
   * by one look per avatar folder; nothing is written.
   */
  async get(videoId: string): Promise<VideoSummary> {
    const library = this.#deps.openLibrary();
    if (library === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `no video ${videoId}: no library is open` });
    let record: VideoRecord;
    try {
      record = await findVideoRecord(videoId, { library, ...(this.#deps.fs === undefined ? {} : { fs: this.#deps.fs }) });
    } catch (error) {
      if (error instanceof VideoNotFoundError) throw new EngineFailure({ code: "NOT_FOUND", detail: `no video ${videoId}` });
      if (error instanceof VideoRecordUnreadableError) throw new EngineFailure({ code: "INTERNAL", detail: "the video's record cannot be read" });
      if (error instanceof LibraryError && error.code === "library-too-new") throw new EngineFailure({ code: "LIBRARY_TOO_NEW", detail: "this video's record was written by a newer version of Studio" });
      // A raw Node error names the library's path: only its code is told.
      this.#deps.log(`videos.get: ${videoId} could not be read (${kindOf(error)})`);
      throw new EngineFailure({ code: "INTERNAL", detail: `the video's record could not be read (${codeOf(error)})` });
    }
    const root = await this.#freshRoot();
    let state: FileState;
    try {
      state = await within(
        this.#deps.recordCheckTimeoutMs ?? RECORD_CHECK_TIMEOUT_MS,
        () => this.#deps.checker.check(record, root, { verify: "cheap", budget: newHashBudget() }),
        () => Object.assign(new Error("the file check did not answer"), { code: "ETIMEDOUT" }),
      );
    } catch (error) {
      this.#deps.log(`videos.get: the file of ${record.id} could not be checked (${kindOf(error)})`);
      state = "unchecked";
    }
    return videoSummaryOf(await this.#withLiveDraft(library, record, new Map()), state);
  }

  /**
   * `record` as the windows should see it: a record is write-once and keeps the id of the draft it came from, but a draft
   * that was deleted since is no draft to open («Изменить»), so it reads `montageId: null`. One look per draft per call
   * (`known`); a disk that cannot be looked at leaves the id as written, since the draft is not known to be gone.
   */
  async #withLiveDraft(library: Library, record: VideoRecord, known: Map<string, boolean>): Promise<VideoRecord> {
    const drafts = this.#deps.drafts;
    const montageId = record.montageId;
    if (drafts === undefined || montageId === null) return record;
    let live = known.get(montageId);
    if (live === undefined) {
      try {
        live = !drafts.wasRemoved(montageId) && (await drafts.exists(library, record.avatarId, montageId));
      } catch (error) {
        this.#deps.log(`videos.list: a montage draft could not be looked at (${kindOf(error)})`);
        live = true;
      }
      known.set(montageId, live);
    }
    return live ? record : { ...record, montageId: null };
  }

  // ---------- videos.delete ----------

  /**
   * By the OWNER'S intent, which the request carries (a state just looked at is never a substitute for it):
   * - `video` («Удалить»): the file (when the FULL check finds it present) and the record. The export folder must be usable, or
   *   nothing is deleted (EXPORT_UNAVAILABLE): a sleeping network drive must not turn this into a record-only delete that
   *   orphans the file. A record whose file is in another root refuses the same way.
   * - `record` («Удалить запись»): ONLY the record, whatever the file's state, and never the file. For `elsewhere` that frees
   *   the photos while the file lives on in the other folder, which is what the owner asked for.
   */
  async delete(videoId: string, mode: "video" | "record"): Promise<{ videoId: string; fileDeleted: boolean; fileState: FileState }> {
    return this.#deps.withLibrary(async (library) => {
      let root: ExportRootRef | null;
      if (mode === "video") {
        const check = await this.#deps.checkExport();
        if (!check.ok) throw new EngineFailure({ code: "EXPORT_UNAVAILABLE", exportReason: check.reason });
        root = await this.#freshRoot(check);
      } else {
        root = await this.#freshRoot();
      }
      let outcome;
      try {
        // Bounded: a hung stat or hash on a dropped drive must not hold the library (`withLibrary` counts this as a write, which
        // a library switch waits for) for ever. What was done before the bound stays done: every step of a delete leaves a state
        // the next one finishes, and the answer says the outcome is not known.
        outcome = await within(
          this.#deps.deleteTimeoutMs ?? DELETE_TIMEOUT_MS,
          () => deleteVideo(videoId, { mode, library, exportRoot: root, checker: this.#deps.checker, ...(this.#deps.fs === undefined ? {} : { fs: this.#deps.fs }), log: this.#deps.log }),
          () => new EngineFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", detail: "the export folder did not answer in time; look at the video list before trying again" }),
        );
      } catch (error) {
        throw this.#deleteFailure(videoId, error);
      }
      this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "video.changed", payload: { change: "removed", videoId, avatarId: outcome.avatarId } });
      this.#announce(library, outcome.avatarId);
      return { videoId, fileDeleted: outcome.fileDeleted, fileState: outcome.fileState };
    });
  }

  #deleteFailure(videoId: string, error: unknown): EngineFailure {
    if (error instanceof EngineFailure) return error;
    if (error instanceof VideoNotFoundError) return new EngineFailure({ code: "NOT_FOUND", detail: `no video ${videoId}` });
    if (error instanceof VideoRecordUnreadableError) return new EngineFailure({ code: "INTERNAL", detail: "the video's record cannot be read" });
    if (error instanceof VideoFileUnreachableError) return new EngineFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "missing", detail: "the video's file is not in the current export folder" });
    if (error instanceof LibraryError && error.code === "library-too-new") return new EngineFailure({ code: "LIBRARY_TOO_NEW", detail: "this video's record was written by a newer version of Studio" });
    // Its message names no path: `VideoDiskError` builds it from a fixed phrase and the disk's code.
    if (error instanceof VideoDiskError) return new EngineFailure({ code: "INTERNAL", detail: error.message });
    // Anything else is a raw Node error, whose message names the owner's path: only its code is told.
    this.#deps.log(`videos.delete: ${videoId} failed (${kindOf(error)})`);
    return new EngineFailure({ code: "INTERNAL", detail: `the video could not be deleted (${codeOf(error)})` });
  }

  // ---------- events ----------

  /** The render queue's events as the contract's. A state and its result travel; the error's `cause` (raw, path-bearing) never does. */
  onQueueEvent(event: RenderQueueEvent): void {
    try {
      switch (event.type) {
        case "started":
          if (event.state.kind === "render") this.#emitProgress(event.state);
          break;
        case "progress":
          this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.progress", payload: event.progress });
          break;
        case "ended":
          this.#ended(event);
          break;
      }
    } catch (error) {
      this.#deps.log(`render queue: an event could not be announced (${kindOf(error)})`);
    }
  }

  /** Where a broken event listener is reported. It logs the error's kind and cannot throw, even if the log does. */
  onListenerError(error: unknown): void {
    try {
      this.#deps.log(`render queue: an event listener threw (${kindOf(error)})`);
    } catch {
      // The last resort of a last resort: the queue must go on.
    }
  }

  #emitProgress(state: Extract<ReturnType<VideoQueue["states"]>[number], { kind: "render" }>): void {
    this.#emit({
      v: PROTOCOL_VERSION,
      id: this.#deps.newId(),
      kind: "event",
      type: "job.progress",
      payload: { kind: "render", jobId: state.jobId, videoId: state.videoId, avatarId: state.avatarId, montageId: state.montageId, done: state.done, total: state.total, ...(state.saving === true ? { saving: true } : {}), ...(state.status === "queued" ? { queued: true } : {}) },
    });
  }

  #ended(event: Extract<RenderQueueEvent, { type: "ended" }>): void {
    const { state } = event;
    if (state.kind !== "render") return;
    const ref = { kind: "render" as const, jobId: state.jobId, videoId: state.videoId, avatarId: state.avatarId, montageId: state.montageId };
    // The cause is for the log, by its kind: it is the RAW error, and Node's system errors carry `path`, `dest` and `spawnargs`.
    this.#deps.log(`render ${state.jobId} ended ${state.status}${event.cause === undefined ? "" : ` (${kindOf(event.cause)})`}`);
    if (state.status === "done" && state.result !== undefined) {
      this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.done", payload: { jobId: state.jobId, result: state.result } });
    } else if (state.status === "failed") {
      const error: EngineError = state.error ?? { code: "INTERNAL", detail: "the render failed" };
      this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.failed", payload: { ...ref, error } });
    } else if (state.status === "cancelled") {
      this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.cancelled", payload: ref });
    }
    const library = this.#deps.openLibrary();
    if (library === null) return;
    // Whatever way it ended, its photos left the reservation: the avatar's counts moved.
    this.#announce(library, state.avatarId);
    // A commit whose index update failed left the avatar closed (`index-stale`): read the record back in the background.
    this.#scheduleStaleRetry(library, state.avatarId);
  }

  /** A record is committed and the used index has it: the window learns of it now, before `job.done`. */
  #committed(record: VideoRecord): void {
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "video.changed", payload: { change: "upserted", video: videoSummaryOf(record, "present") } });
    const library = this.#deps.openLibrary();
    if (library !== null) this.#announce(library, record.avatarId);
  }

  /** Emits, and never throws: a closed window must not fail a commit or stop the queue. */
  #emit(event: UnsequencedEvent): void {
    try {
      this.#deps.emit(event);
    } catch (error) {
      this.#deps.log(`an event (${event.type}) could not be emitted (${kindOf(error)})`);
    }
  }

  #announce(library: Library, avatarId: string): void {
    try {
      this.#deps.announceAvatar(library, avatarId);
    } catch (error) {
      this.#deps.log(`avatar ${avatarId} could not be announced (${kindOf(error)})`);
    }
  }

  // ---------- the export root ----------

  /** The export root as it is right now (its marker read now), or null when it is unusable: what the file states, delete and recovery judge files against. */
  async #freshRoot(known?: ExportRootCheck): Promise<ExportRootRef | null> {
    const check = known ?? (await this.#deps.checkExport());
    if (!check.ok) return null;
    let caseInsensitive = true; // the cautious answer: it can only make comparisons stricter
    try {
      // The probe writes a file in the export folder: on a volume that has gone quiet it never returns, so it is bounded, and the cautious answer stands.
      caseInsensitive = await within(this.#deps.caseProbeTimeoutMs ?? CASE_PROBE_TIMEOUT_MS, () => this.#deps.caseProbe.isCaseInsensitive(check.root), () => Object.assign(new Error("the case probe did not answer"), { code: "ETIMEDOUT" }));
    } catch (error) {
      this.#deps.log(`the export folder's case rule could not be probed (${kindOf(error)}); the cautious one is used`);
    }
    return { root: check.root, rootId: check.rootId, caseInsensitive };
  }

  // ---------- startup, recovery, stale index ----------

  /**
   * At engine start: sweeps `render-tmp` (leaving the folders of live renders) and settles the open library's crash
   * windows. In the BACKGROUND: neither is awaited by the start, by a command or by a render; a hung disk costs nothing but
   * its own task, and a failure is logged. Never called from a commit path.
   *
   * `exportCheck` is the check the start has just made (its marker was read moments ago): recovery judges against it
   * instead of asking again, so the background never adds a second look at a slow export drive and never moves the
   * export status a window shows.
   */
  startup(library: Library | null, exportCheck?: ExportRootCheck): void {
    this.#track(async () => {
      await this.#sweepRenderTmp();
    });
    if (library !== null) this.#startRecovery(library, exportCheck);
  }

  /**
   * A library became the live one (a switch): the recovery of any other library is told to stop (it must not go on holding
   * the export root's lock for a library nobody looks at), and this one's crash windows are settled, in the background.
   */
  libraryOpened(library: Library): void {
    for (const [other, controller] of this.#recoveries) if (other !== library) controller.abort();
    for (const handle of this.#staleChains.values()) this.#timers.clear(handle);
    this.#staleChains.clear();
    this.#startRecovery(library);
  }

  /** Resolves once the background work started so far is done (tests, and shutdown). Never rejects. */
  async settled(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]);
  }

  #track(work: () => Promise<void>): void {
    const task = work().catch((error: unknown) => {
      this.#deps.log(`background work failed (${kindOf(error)})`);
    });
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }

  #startRecovery(library: Library, exportCheck?: ExportRootCheck): void {
    const controller = new AbortController();
    this.#recoveries.get(library)?.abort();
    this.#recoveries.set(library, controller);
    this.#track(async () => {
      try {
        await this.#recover(library, controller.signal, { ...(exportCheck === undefined ? {} : { exportCheck }) });
      } finally {
        if (this.#recoveries.get(library) === controller) this.#recoveries.delete(library);
      }
    });
  }

  async #sweepRenderTmp(): Promise<void> {
    const dir = this.#deps.renderTmpDir;
    if (dir === undefined) return;
    // The text folder belongs to the text previews (they clear it themselves), so a preview written just after start is never swept.
    const swept = await sweepRenderTmp(dir, { keep: (name) => name === TEXT_PREVIEW_DIR || this.#deps.tracker.hasJob(name) });
    for (const { code } of swept.skipped) this.#deps.log(`a leftover in render-tmp could not be removed (${code}); the next start tries again`);
  }

  async #recover(library: Library, signal: AbortSignal, options: { exportCheck?: ExportRootCheck; only?: { videoIds: readonly string[] } }): Promise<void> {
    const deps = this.#deps;
    // What each avatar's photos looked like (which are held, how many are free) before recovery held or freed any: what is announced is what moved.
    const before = this.#heldKeys(library);
    // The library's pending intents are read and their photos held FIRST, before the export root is asked anything: a slow or hung root must not leave the
    // photos free at the start. A step of its own, so a test's stand-in for the whole recovery is not called twice.
    if (options.only === undefined) {
      try {
        await recoverVideos({ library, exportRoot: null, live: deps.tracker, signal, holdOnly: true }, { log: deps.log, ...deps.recover?.deps });
      } catch (error) {
        deps.log(`recovery: the pending intents' photos could not be held first (${kindOf(error)})`);
      }
      if (signal.aborted) return;
      this.#announceHeldChanges(library, before);
    }
    // A FRESH look at the root, and the SAME tracker the renders register in: a live commit is never taken for a crash's leftover.
    const exportRoot = await this.#freshRoot(options.exportCheck);
    if (signal.aborted) return;
    const run = deps.recover?.run ?? recoverVideos;
    const report = await run({ library, exportRoot, live: deps.tracker, signal, ...(options.only === undefined ? {} : { only: options.only }) }, { log: deps.log, ...deps.recover?.deps });
    // Counts only, and only when there was something to settle: a clean open is silent.
    if (report.adopted.length + report.dropped.length + report.deferred.length + report.left.length + report.skipped.length > 0) {
      deps.log(`recovery: ${report.adopted.length} adopted, ${report.dropped.length} dropped, ${report.deferred.length} deferred, ${report.left.length} left, ${report.skipped.length} skipped`);
    }
    // Adopted records are new to the windows; a library that is no longer the live one has no windows to tell.
    if (deps.openLibrary() === library) {
      const avatars = new Set<string>();
      for (const videoId of report.adopted) {
        const avatarId = await this.#announceAdopted(library, videoId);
        if (avatarId !== null) avatars.add(avatarId);
      }
      // Their photos are used now: the avatars' counts moved. So did those of an avatar whose photos recovery held or freed.
      for (const avatarId of avatars) this.#announce(library, avatarId);
      this.#announceHeldChanges(library, before, avatars);
    }
    if (options.only === undefined) for (const manifest of library.listAvatars()) this.#scheduleStaleRetry(library, manifest.id);
  }

  /** Per avatar, the photos that are held (reserved) and how many are free: a change in either is something the windows have not been told. */
  #heldKeys(library: Library): Map<string, string> {
    return new Map(
      library.listAvatars().map((manifest) => {
        const held = [...library.photoStates(manifest.id)].filter(([, state]) => state.reserved).map(([photoId]) => photoId).sort();
        return [manifest.id, `${held.join(",")}|${library.eligibleUnusedCount(manifest.id)}`];
      }),
    );
  }

  /** Announces the avatars whose held photos or free count differ from `before` (and were not announced already), then `before` is brought up to date. */
  #announceHeldChanges(library: Library, before: Map<string, string>, already: ReadonlySet<string> = new Set()): void {
    if (this.#deps.openLibrary() !== library) return;
    const now = this.#heldKeys(library);
    for (const [avatarId, key] of now) {
      if (before.get(avatarId) !== key && !already.has(avatarId)) this.#announce(library, avatarId);
      before.set(avatarId, key);
    }
  }

  /** The avatar the adopted record belongs to (announced), or null when it could not be read back. */
  async #announceAdopted(library: Library, videoId: string): Promise<string | null> {
    for (const manifest of library.listAvatars()) {
      let record: VideoRecord | null;
      try {
        record = await readVideoRecordFile(library.root, manifest.id, videoId);
      } catch (error) {
        this.#deps.log(`recovery: the adopted record ${videoId} could not be read back (${kindOf(error)})`);
        continue;
      }
      // Recovery has just verified the file's size and sha256: it is present.
      if (record !== null) {
        this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "video.changed", payload: { change: "upserted", video: videoSummaryOf(await this.#withLiveDraft(library, record, new Map()), "present") } });
        return record.avatarId;
      }
    }
    return null;
  }

  /**
   * A commit failed after it wrote its intent and could not take its file back: settle THAT intent now (targeted recovery under
   * the export root's lock), from inside the job, while the queue still holds the photos. The record when it was adopted,
   * else null (dropped, deferred, or nothing was left, the usual case: the rollback removed it).
   * The job is told apart from the others so that its own intent is not "live"; the commit is over, so the lock is free.
   */
  async #settleLeftover(library: Library, input: SettleInput, signal: AbortSignal): Promise<VideoRecord | null> {
    // Held FIRST: this settle may fail, hang (it is cut by its bound) or never get to its recovery, and the intent is on the disk until something says otherwise.
    // Only an intent the disk says is gone (ENOENT) ends the hold; any other answer leaves the photos held.
    library.holdPendingPhotos(input.avatarId, input.videoId, input.photoIds);
    try {
      await (this.#deps.intentLstat ?? lstat)(videoPaths(library.root, input.avatarId).intent(input.videoId));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) library.releasePendingPhotos(input.videoId);
      else this.#deps.log(`the commit intent of ${input.videoId} could not be looked at (${kindOf(error)}); its photos stay held`);
      return null;
    }
    const tracker = this.#deps.tracker;
    const live: LiveCommits = { hasJob: (id) => id !== input.jobId && tracker.hasJob(id), hasTemp: (p) => tracker.hasTemp(p), hasPlaceholder: (p) => tracker.hasPlaceholder(p) };
    const run = this.#deps.recover?.run ?? recoverVideos;
    const report = await run({ library, exportRoot: input.exportRoot, live, signal, only: { videoIds: [input.videoId] } }, { log: this.#deps.log, ...this.#deps.recover?.deps });
    if (!report.adopted.includes(input.videoId)) return null;
    return readVideoRecordFile(library.root, input.avatarId, input.videoId);
  }

  /**
   * The used index of `avatarId` is behind its committed videos (`index-stale`): read the records again in the background,
   * on a schedule whose last delay REPEATS until the records are read (or the library is no longer the live one). One chain
   * per avatar: a second request while one is running changes nothing. (`videos.render` and `videos.list` also read the
   * records again on demand, so the avatar is not closed for the wait.)
   */
  #scheduleStaleRetry(library: Library, avatarId: string, attempt = 0): void {
    const delays = this.#deps.staleRetryDelaysMs ?? DEFAULT_STALE_RETRY_DELAYS_MS;
    if (this.#closing || delays.length === 0) return;
    if (attempt === 0 && (this.#staleChains.has(avatarId) || library.videoIndexStale(avatarId).length === 0)) return;
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
    // The chain's entry stays from the first timer until the chain ENDS (the records read, or the library gone), through the
    // retry itself: a request that arrives while a retry is reading finds the entry and starts nothing (no forked chain).
    const handle = this.#timers.set(() => void this.#retryStale(library, avatarId, attempt), delay);
    this.#staleChains.set(avatarId, handle);
  }

  async #retryStale(library: Library, avatarId: string, attempt: number): Promise<void> {
    if (this.#closing || this.#deps.openLibrary() !== library) {
      this.#staleChains.delete(avatarId);
      return;
    }
    try {
      await library.reloadVideoRecords(avatarId);
    } catch (error) {
      this.#deps.log(`the used index of avatar ${avatarId} could not be rebuilt (${kindOf(error)})`);
    }
    // Nothing else clears the flag: a quarantine or a "repair" must never act on it (no record is broken).
    if (library.videoIndexStale(avatarId).length > 0 && !this.#closing) this.#scheduleStaleRetry(library, avatarId, attempt + 1);
    else this.#staleChains.delete(avatarId);
  }

  // ---------- stop ----------

  /**
   * The engine is stopping (the app quits): no render is accepted from now on, every queued and running render is
   * cancelled, and a bounded wait lets a commit that is past its claim finish (its record and file are then complete,
   * and the used index has them). `idle` says whether every job had ended within the bound; if not, the engine's
   * process is ended anyway and the next start's recovery settles what is left. Orphaned ffmpeg children die with
   * their parent's cancel, so none keeps writing into the export folder.
   */
  async shutdown(boundMs: number): Promise<{ idle: boolean }> {
    this.#closing = true;
    for (const handle of this.#staleChains.values()) this.#timers.clear(handle);
    this.#staleChains.clear();
    for (const controller of this.#recoveries.values()) controller.abort();
    for (const state of this.#deps.queue.states()) {
      if (state.kind === "render" && (state.status === "queued" || state.status === "running")) this.#deps.queue.cancel(state.jobId);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), boundMs);
    });
    try {
      const outcome = await Promise.race([this.#deps.queue.idle().then(() => "idle" as const), bound]);
      if (outcome === "timeout") {
        const unfinished = this.#deps.queue.states().filter((s) => s.kind === "render" && (s.status === "queued" || s.status === "running")).length;
        this.#deps.log(`shutdown: ${unfinished} render(s) had not ended within ${boundMs} ms; the next start's recovery settles what they left`);
      }
      return { idle: outcome === "idle" };
    } finally {
      clearTimeout(timer);
    }
  }
}

import { decodePhotoCursor, type EngineError, type EventMessage } from "../../../shared/engine";
import { FRAME_H, FRAME_W } from "../../../shared/montage";
import { ImportProgressInvariants, ProgressInvariants } from "./progress";

// The parity harness's record of a scenario (Stage 3, 3d.1b): what was asked, what was answered and every event, in the order
// it happened, written as plain lines. The SAME scenario runs against the mock and against the real engine, each writes its
// transcript, and the two must be equal line for line. So a line says only what both engines are bound to say the same:
//
//  - identifiers are replaced by their role and the order they first appear in (`montage#1`, `job#2`, `photo#3`): the engine
//    draws ids from its own generator and the mock counts;
//  - what may differ on purpose is MASKED, each with its reason in `MASKED` below and the rest in `INTENTIONAL_DIFFERENCES`;
//  - only the events the montage, video and render commands are answerable for are written (`COVERED_EVENTS`): the engine also
//    sends `settings.changed`, `money.changed` and others that no command of this suite is about.

/** A command's answer as both rigs give it: the result, or the engine's error. */
export type Answer = { readonly ok: true; readonly result: Record<string, unknown> } | { readonly ok: false; readonly error: EngineError };

/** The events whose order is under test. */
export const COVERED_EVENTS: ReadonlySet<string> = new Set(["job.progress", "job.done", "job.failed", "job.cancelled", "video.changed", "montage.changed", "avatar.changed", "export.status", "music.changed", "media.changed"]);

/**
 * Values that differ between the mock and the engine by design, with why. A masked field is written as `"<masked>"`; whether the
 * field is present, and every other field, is still compared.
 */
export const MASKED: Readonly<Record<string, string>> = {
  updatedAt: "when a draft was last written: the mock's clock and the engine's are different clocks",
  createdAt: "when a record or an avatar was made: the same",
  bytes: "a video's size: the mock estimates it from the montage, the engine's fake ffmpeg wrote a fixed file",
  seed: "a new draft's variety seed: the engine draws one at random, the mock counts",
};

/**
 * What the mock does differently from the engine ON PURPOSE, and how the harness treats it. Each entry is a rule of `Transcript`
 * or of `Normalizer`, not a gap: anything not listed here must be equal.
 */
export const INTENTIONAL_DIFFERENCES: readonly string[] = [
  "progress: the engine's steps follow ffmpeg's frames over two passes, the mock has a fixed number of steps; a run of `mid` progress events is collapsed to one, and the start (done 0), the saving phase and the total are compared exactly",
  "timing: the engine's render ends when its ffmpeg stops, the mock's after its own clock; scenarios move time only through `advance` and `settle`, and a running render's cancel is followed by a `settle`",
  "identifiers: replaced by role and order of appearance; the timestamps, seeds and byte sizes in `MASKED` are masked",
  "file names: the date in a video's `relPath` is masked (the mock's clock against the engine's), and the mock's folder name is ASCII only (no Cyrillic transliteration)",
  "VALIDATION: the engine and the renderer's client both refuse a payload that breaks the contract, in different words: the code is compared, not the detail",
  "events the suite is not about (settings.changed, money.changed, ...) are not written",
  "render pool: «auto» is ONE render at a time in the mock (the engine picks by cores and memory), so a second render is visibly queued; scenarios set the pool explicitly",
  "the mock's clock: a render makes 4 progress steps 700 ms apart, then the saving phase, then commits one step later; a running render's cancel ends after 50 ms. The engine's times follow its work: no scenario waits for either, and the numbers of steps are checked by rule (progress.ts)",
  "bursts: commands sent together are answered in the order sent by both, and each echo comes before its answer; how the echoes of one burst interleave with the answers of others is not compared (the engine writes a file per save, the mock answers at once)",
  "the export folder's dialog: main's own flow runs over the real engine in the real rig, and the mock plays both; the settings a pick answers carry the rig's own paths and are not written (the folder's identity as `root#N`, and the counts, are). In the app the engine's export.status after a switch may land just after main's answer; the rig applies it first, so the transcript has it before the answer. `settings.exportDisplay` is main's own string and is tested in main",
  "the mock keeps the drafts, the videos and the last 50 finished renders in memory: a restart keeps the first two and drops the renders, like the engine's; nothing else of the disk is modelled (no torn draft files, no stale used index, no record from a newer Studio, no closed library): those refusals are the engine's own unit tests' business",
  "settings answers (image model choice): `settings.get`, `settings.setModels` and `settings.setCameraRealism` answer the whole settings, whose paths, key tail and age-check mode are the rig's own (a temp dir and the harness's «on» against the mock's home and «off»): only `imageModel`, `imageQuality`, `textModel` and `cameraRealism` are written. `settings.imageModels` is compared whole: the real engine runs offline in the rig, so it answers its bundled list, which the mock serves as its fixed catalogue; the live list and the price fetches are the catalogue's own unit tests' business. `settings.setModels` and `settings.setCameraRealism` run main's own flow (main/settingsFlow.ts) over the real engine and a real settings file in the real rig",
  "usage (K16): the mock models an avatar's unknown usage as the reasons it was seeded with, and the engine finds the same from broken files (`usageUnknownScenario`); but the mock cannot read a stale used index again, so a seeded `index-stale` stays stale, where the engine's render first rereads the records (bounded) and goes through once they are in step. `index-stale` is memory only, never a file, so it is held by both engines' unit tests and not by a scenario",
  "pending-video: a photo held only by an unfinished video's pending intent (`PhotoUnavailableReason` `pending-video`) is staged in the mock by `holdPendingVideoPhotos`; the real rig cannot stage it without a recovery that defers an intent (an export folder that is absent at start, or another process's lock), which the rig's folder never is. The engine's recovery tests hold the hold itself, the engine's and the mock's unit tests hold the reason and the count; no scenario compares them",
  "text previews (3d.1b): the engine draws a caption with its rasteriser, the mock does not: its box is the engine's own layout over an arithmetic width (0.55 em a character, no font) and its picture a placeholder PNG of that box. So `width` and `height` are written as `<px>` after checking they are whole pixels inside the frame, and the picture's bytes are not compared (that they are a PNG of the answered box is the mock's own test). The mock draws every well-formed emoji; the engine refuses a cluster its font lacks (`emoji-missing`), so no story uses one it cannot draw. The time one drawing takes is not modelled by the suite: a rig's text lane is held and let go by the scenario",
  "music list and peaks (3d.1b): the real rig's store holds tracks it downloaded from a fake CDN, the mock's are seeded from the same fixture list; both answer through the track store's own highlight and waveform rules (studio/shared/music/trackShape.ts). The mock models no disk for a track: no torn envelope file, no track deleted under a live record (the engine's `peaks` is then NOT_FOUND while `list` still lists it, until a restart), no cover file: those are the store's own unit tests' business, and no story deletes the music folder after storing tracks. The cap of 100 listed tracks is not played: the real rig would have to download 101 tracks; it is pinned by the mock's own test and the track store's",
  "a video's first clip (3e.2): the engine's record holds the RESOLVED spec (every focus filled, the stand-in point where no face was found), the mock's the draft's (null there); `videos.get` writes the clip as its kind, layout and photos, never its focus, and the older stories' lines leave out the title, the first clip and the track id (no older golden line changed)",
  "usage (3e.2): the mock has no disk, so an avatar's broken records or marks are the usage it was seeded with (a renderer test's state) and a recovery clears its own reason; the engine moves or copies files. No story breaks a file: the suite plays the recoveries of a sound avatar, which change nothing on either. `photos.rebuildRejected`'s `kept` is the engine's count of readable log lines and the mock's of rejected photos: equal for a log of one mark per photo, which is what the story writes",
  "own media (3f.1b): the mock has no disk and copies nothing. An accepted file's job is a timer on the mock's clock: it announces its start, then (when released, one step later) one progress step at the total, the stored record, and its end; the engine's copy announces one step per percent. The rule is the same as for renders: the start and the total are compared, the steps between are collapsed (the file in the story is one chunk, so there are none). A held import (`holdImports`) is a copy held before its first byte in the real rig and a timer that is not set in the mock. The mock accepts what the dialog's script says it accepts and refuses the rest with the script's reason; it models no importer, no staging folder, no crash window and no record that cannot be read: those are the engine's own unit tests' business. `media.changed` is written, with the media's id as `media#N`",
  "music (3c.6): the mock keeps its quota log and its list as numbers on its own clock, so the times a status carries (`listFetchedAt`, `nextFreeAt`) are written as set or null, a refresh's steps are not written, and a music error's detail (it names a time) is not compared: its code and its `musicReason` are. No story sends a flashapi request: the real rig's flashapi refuses every call",
  "own media, the prepare stage (3f.6): an import's progress is the copy in bytes (no `stage`) and then, when the importer reports its work, the prepare in the importer's own units (`stage: \"prepare\"`, from zero of its own total, with what the probe judged for a video). The stand-in importers of the real rig report nothing but for the `preparedVideo` pick, and the mock plays a prepare only for a file whose script has `accept.prepare`, so no older story gained a line (the golden is append-only). The engine announces a percent of the prepare at a time and the mock the steps its script names: the steps between the start and the end are collapsed, and the rules they must satisfy (copy before prepare, never back, never full before the record, the judged facts unchanged) are checked on both engines (progress.ts). With `prepare` and `failWith` together the mock always begins the stage and then fails the job, while the engine's importer begins it only once it has gone past its own early refusals: a `codec` refusal and a `too-short` caught before the encode fail the job with no prepare stage at all; no story uses the pair",
  "scene sets and categories (CS.2, CS.4a, CS.4b, CS.5): only the FREE commands and the free refusals of the paid ones are played. The rig scripts no chat, so `categories.create` / `.regenerate`, `scenes.compose`, `scenes.write` (every target) and `runs.startFromScenes` have their own engine and mock tests (engine.categories, engine.sceneSets*, engine.scenesRuns, mockEngine.category/sceneSets*/sceneRuns/sceneParity). The estimates (`categories.estimate`, `scenes.estimateCompose`, the price a `scenes.estimateWrite` answers, `runs.estimateFromScenes`) are not compared: the mock's prices are «live», the engine's offline ones the bundled table; the refusals that come before a price are compared",
  "the age check and the other gates of a start from a scene set (CS.5): the real rig's engine runs with the harness's age check «on» and the mock with its own «off», as for `runs.start`; a start that goes through draws images, which this rig does not script, so only its refusals before the gates are played",
  "a redraw (CS.4b): the mock draws a new place from its own small tables, the engine from the planner's pools (a custom category's own pool included), so what a redraw picks is not compared, only its refusals. The category-name snapshot a redraw takes is the engine's own (taken when the write is planned, a newer write's never undone); the mock keeps the same rule in its own tests (mockEngine.sceneParity)",
  "events of the slice: `scenes.changed` and `category.changed` are not in `COVERED_EVENTS`, so their order against `job.*` (the set is announced before the job's own end, and before `job.cancelled`) is held by the engine's and the mock's own tests, not by a transcript. The refusals' `sceneReason` and `sceneId` (and `categoryReason`) are compared",
  "scene set files and the ledger (CS.7): the mock has no disk, so a set file or folder the OS refuses, a record whose close was lost, and a ledger that cannot be read are states a test seeds (`unreadableSceneSets`, `money.unavailable`); the engine finds them in the stores, whose own tests hold them. A `scenes.cancel` opens a reserve in the mock by a control (`setSceneCancelOutcome`), in the engine only when a request was at the model; the order `job.cancelled` before the answer of a write is played by `cancelNextSceneWriteBeforeAnswer`, not by a transcript",
  "the batch autopilot (Stage 4, S4.1): the real engine answers every autopilot command INTERNAL «<type> is not implemented yet» until its orchestrator lands (S4.6), the mock answers a plan, a price and a launch held in a canned state. So a story that needs the engine to serve the command is PENDING (`Scenario.pending`): the mock's transcript is bound to the golden, and the harness only checks that the real engine answers each named command with that one refusal; the story joins the full comparison when `pending` is taken off (S4.6 to S4.8). The payloads the CONTRACT refuses are refused by both and compared now. What a pending story writes is limited to what the engine will also say: the plan's counts, the states and the codes, not the prices (as for every estimate), the clock, or the spend of a launch",
  "a launch that RUNS (Stage 4, S4.8): the real rig runs the engine's default launch steps over a fake OpenRouter, the rig's fake ffmpeg and its track store; the mock runs its launch on its clock (`RigOptions.launch`). Both are read only at the STABLE points a story waits for (`Transcript.untilLaunch`), through `callLaunch`, which writes `launchFacts` (state, holds, reasons, rows' phases and progress, videos by state) and NOT: the prices, the clock, how many requests a batch sends or are in flight while the launch moves, the set file's revision (the engine's compose makes it 3, an approval 4: the contract says a set is named with one, not which), the text of a launch's refusals (sums and sentences of the engine's own: the code and the reason are written), or the events the launch causes (`autopilot.changed` is coalesced by the engine and sent per pass by the mock; the older stories' covered events are not written during a launch). The stories plan every photo NEW (`library: false`): a generated video asks for the same photos from both planners (1, 3, 5), but the photos a LIBRARY video takes are drawn by the engine's planner from the seed (collages of 2 to 4, slides of 5 to 7, near-duplicates refused) and are fixed in the mock, as are the order of the shapes and the categories: the library plan's counts are held by each engine's own tests, and the five S4.1 stories whose commands plan from the library stay pending for that reason. The bounded automatic continues after a drop (1 and 5 minutes) and the price list's retries (5, 15, 60) wait real minutes in the engine: the mock's tests hold them, the engine's own (paidHolds, engine.autopilotHolds), and no story waits for them. The quit is the graceful one (`paused { quit }`); the engine's other restart, a crash read as `paused { engine-restart }`, needs the crash matrix's copy of the folders (engine.autopilotCrashMatrix) and is played against the mock by its own tests",
  "the price of drawing photos (S4.6p, `runs.estimateImages`): the figures are each engine's own prices (the mock's fixed image price, the engine's bundled table), so the transcript writes the photos the price is for, that expected is within worst, that the figure is above zero exactly when there are photos, and that it names its source; the two are held to the same figure by the engine's and the mock's own suites. A refusal's text names the launch or the avatar in each engine's words: its code is compared",
  "the plan card's figures (S4.10 fix B, `Transcript.callCard`): the number of candidate tracks, the OpenRouter balance in micro-dollars and the export volume's free bytes are each rig's own (the rig's track list and the mock's canned figures, the fake OpenRouter's credits, a free-space figure the story sets), so a story that asks writes only that they are FILLED (`candidates > 0`, `balance !== null`, `freeBytes !== null`); the word on the automatic refresh is written by every estimate and is the same rule in both engines (shared/autopilot/autoRefresh.ts)",
];

/** A music status as both rigs can be bound to it: the counts, the log's state and the refresh's state; the times as set or null. */
function musicLine(status: unknown): Record<string, unknown> {
  const s = objectOf(status);
  const refresh = objectOf(s.refresh);
  const error = refresh.state === "failed" ? objectOf(refresh.error) : null;
  return {
    sentLast31d: s.sentLast31d,
    limit: s.limit,
    quotaLog: s.quotaLog,
    serverRemaining: s.serverRemaining,
    nextFreeAt: s.nextFreeAt === null ? null : "<set>",
    listFetchedAt: s.listFetchedAt === null ? null : "<set>",
    trackCount: s.trackCount,
    refresh: error === null ? refresh.state : { state: "failed", code: error.code, ...(error.musicReason === undefined ? {} : { musicReason: error.musicReason }) },
  };
}

const ID_KINDS: Readonly<Record<string, string>> = {
  avatarId: "avatar",
  masterPhotoId: "photo",
  photoId: "photo",
  montageId: "montage",
  videoId: "video",
  jobId: "job",
  launchId: "launch",
  sceneSetId: "set",
  previewId: "preview",
  clipId: "clip",
  layerId: "layer",
};
const ID_LIST_KINDS: Readonly<Record<string, string>> = { photoIds: "photo", usedIn: "video", jobIds: "job", rejectedPhotoIds: "photo" };

/** Replaces identifiers by their role and order of appearance, and masks what `MASKED` lists. */
export class Normalizer {
  readonly #aliases = new Map<string, string>();
  readonly #counts = new Map<string, number>();

  /** Names an identifier the harness already knows (the seeded avatars and photos), so their numbers follow the seed order and not the first appearance. */
  register(kind: string, id: string): string {
    const known = this.#aliases.get(id);
    if (known !== undefined) return known;
    const n = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, n);
    const alias = `${kind}#${n}`;
    this.#aliases.set(id, alias);
    return alias;
  }

  /** Names an own media's id, in order of first appearance (`media#1`), so every later line of the transcript writes it the same way. */
  registerMedia(id: string): void {
    this.register("media", id);
  }

  /** A free text (an error's detail) with every known identifier in it replaced. */
  text(raw: string): string {
    let out = raw;
    for (const [id, alias] of [...this.#aliases].sort((a, b) => b[0].length - a[0].length)) out = out.split(id).join(alias);
    return out;
  }

  value(value: unknown, key?: string): unknown {
    if (typeof value === "string") {
      const kind = key === undefined ? undefined : ID_KINDS[key];
      if (kind !== undefined) return this.register(kind, value);
      // An own media's id is aliased once the transcript has MET it (`registerMedia`: the first `media.changed` or listing that carries it): the
      // older stories name their own-media ids by hand, and those stay as written.
      if (key === "mediaId" && this.#aliases.has(value)) return this.register("media", value);
      // S4.P2: a photos.list cursor is `<createdAt>|<photoId>`: the time is masked like every createdAt, the photo is named by its alias.
      if (key === "cursor") {
        const position = decodePhotoCursor(value);
        return position === null ? this.text(value) : `<masked>|${this.register("photo", position.photoId)}`;
      }
      if (key !== undefined && key in MASKED) return "<masked>";
      if (key === "relPath") return value.replace(/\d{4}-\d{2}-\d{2}/, "<date>");
      return this.text(value);
    }
    if (typeof value === "number") return key !== undefined && key in MASKED ? "<masked>" : value;
    if (Array.isArray(value)) {
      const kind = key === undefined ? undefined : ID_LIST_KINDS[key];
      return value.map((item) => (kind !== undefined && typeof item === "string" ? this.register(kind, item) : this.value(item)));
    }
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.value(v, k)]));
    return value;
  }
}

const compact = (value: unknown): string => JSON.stringify(value);

function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
  return Object.fromEntries(Object.entries(value));
}

/**
 * A video summary in the shape the stories before 3e.2 were written in: the tile's title, its first clip and the track id (3e.2,
 * K12, K13) are left out, so no older golden line changed. A story about them asks `videos.get` (`videoFactsLine`).
 */
function videoLine(video: unknown): Record<string, unknown> {
  const { title: _title, firstClip: _firstClip, publishedAt, ...withoutMark } = objectOf(video);
  // Stage 4: the owner's «Опубликовано» mark is written as set or null (its time is a clock); a video never marked has no field, so no older line changed.
  const rest = typeof publishedAt === "string" ? { ...withoutMark, publishedAt: "<set>" } : publishedAt === null ? { ...withoutMark, publishedAt: null } : withoutMark;
  if (rest.music === null || rest.music === undefined) return rest;
  const { trackId: _trackId, ...music } = objectOf(rest.music);
  return { ...rest, music };
}

/**
 * What 3e.2 added to a video summary, as both engines are bound to it: the title, the track id, and the first clip as its kind,
 * layout and photos. The clip's focus is not written: the engine's record holds the RESOLVED spec (the stand-in point where no
 * face was found), the mock's the draft's (null there).
 */
function videoFactsLine(video: unknown): Record<string, unknown> {
  const v = objectOf(video);
  const music = v.music === null || v.music === undefined ? null : objectOf(v.music);
  const clip = v.firstClip === null || v.firstClip === undefined ? null : objectOf(v.firstClip);
  const cells = clip === null ? [] : clip.kind === "photo" ? [clip.cell] : clip.kind === "collage" && Array.isArray(clip.cells) ? clip.cells : [];
  const photos = cells.map((cell) => {
    const photo = objectOf(cell).photo;
    return photo === null ? null : objectOf(photo).photoId ?? objectOf(photo).mediaId ?? null;
  });
  return {
    title: v.title,
    trackId: music === null ? null : music.trackId,
    firstClip: clip === null ? null : { kind: clip.kind, ...(clip.kind === "collage" ? { layout: clip.layout } : {}), photoIds: photos },
  };
}

/**
 * The avatar as the grid shows it, less what differs by construction (the descriptor text, the date). Its usage (3e.2, K16) is
 * written only when it is not `ok`, so no older golden line changed, and a mock that calls a sound avatar's usage unknown (or
 * the reverse) is seen.
 */
function avatarLine(avatar: unknown): Record<string, unknown> {
  const a = objectOf(avatar);
  const usage = a.usage === undefined || a.usage === null ? null : objectOf(a.usage);
  return {
    avatarId: a.avatarId,
    name: a.name,
    status: a.status,
    photoCount: a.photoCount,
    videoCount: a.videoCount,
    eligibleUnusedCount: a.eligibleUnusedCount,
    ...(usage?.state === "ok" ? {} : { usage: a.usage ?? null }),
  };
}

/** One event as a line of the transcript, or null for an event the suite is not about. */
export function eventLine(event: EventMessage, norm: Normalizer): string | null {
  if (!COVERED_EVENTS.has(event.type)) return null;
  if (event.type === "job.progress") {
    const p = objectOf(event.payload);
    const done = typeof p.done === "number" ? p.done : -1;
    const phase = p.saving === true ? "saving" : done === 0 ? "start" : "mid";
    // `queued` is not written (it would rewrite every queued render's line in the older stories): a scenario that is about it asks
    // `Transcript.announcedQueued()` and writes the answer as a note.
    const { done: _done, saving: _saving, queued: _queued, ...rest } = p;
    return `event job.progress ${compact({ ...objectOf(norm.value(rest)), phase })}`;
  }
  if (event.type === "avatar.changed") return `event avatar.changed ${compact(norm.value(avatarLine(objectOf(event.payload).avatar)))}`;
  if (event.type === "media.changed" && event.payload.change === "upserted") norm.registerMedia(event.payload.media.mediaId);
  if (event.type === "music.changed") return `event music.changed ${compact(musicLine(event.payload.status))}`;
  if (event.type === "video.changed" && event.payload.change === "upserted") return `event video.changed ${compact(norm.value({ change: "upserted", video: videoLine(event.payload.video) }))}`;
  return `event ${event.type} ${compact(norm.value(event.payload))}`;
}

/** A list of `photo#N` aliases as their numbers, each run of neighbours (22, 21, 20 or 3, 4, 5) as `first..last`. */
function orderOf(aliases: readonly unknown[]): string {
  const numbers = aliases.map((alias) => Number(String(alias).split("#")[1]));
  const parts: string[] = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    const step = numbers[i + 1] === undefined ? 0 : (numbers[i + 1] ?? 0) - (numbers[i] ?? 0);
    while (Math.abs(step) === 1 && numbers[j + 1] === (numbers[j] ?? 0) + step) j++;
    parts.push(j > i ? `${numbers[i]}..${numbers[j]}` : String(numbers[i]));
    i = j + 1;
  }
  return parts.join(",");
}

/** The kind of a job's `done` in a snapshot: not the number (the engine's steps differ from the mock's), where it stands. */
function doneKind(done: unknown, total: unknown): string {
  if (done === 0) return "zero";
  return done === total ? "total" : "mid";
}

/**
 * What a window resyncs from (`engine.snapshot`): the jobs it lists in order, the export folder's status as the last check left
 * it, and each avatar's counts. A long list of jobs is written as the count of each status, its first and its last.
 */
function snapshotLine(result: Record<string, unknown>, norm: Normalizer): string {
  const jobs = (Array.isArray(result.jobs) ? result.jobs : []).map((job) => objectOf(job));
  const one = (job: Record<string, unknown>): unknown =>
    norm.value({
      kind: job.kind,
      jobId: job.jobId,
      videoId: job.videoId,
      avatarId: job.avatarId,
      montageId: job.montageId,
      status: job.status,
      total: job.total,
      done: doneKind(job.done, job.total),
      ...(job.saving === true ? { saving: true } : {}),
      ...(job.error === undefined ? {} : { error: job.error }),
      ...(job.result === undefined ? {} : { result: { videoId: objectOf(job.result).videoId, relPath: objectOf(job.result).relPath } }),
    });
  const byStatus: Record<string, number> = {};
  for (const job of jobs) byStatus[String(job.status)] = (byStatus[String(job.status)] ?? 0) + 1;
  const shown = jobs.length <= 8 ? { jobs: jobs.map(one) } : { jobs: jobs.length, byStatus, first: one(jobs[0] ?? {}), last: one(jobs.at(-1) ?? {}) };
  const avatars = (Array.isArray(result.avatars) ? result.avatars : []).map((a) => norm.value(avatarLine(a)));
  return `< ok snapshot ${compact({ ...shown, exportStatus: result.exportStatus, avatars })}`;
}

/**
 * What a launch that RUNS is bound to say (Stage 4, S4.8): its state, its holds and its reasons, its rows' phases and progress, and the facts of its videos. NOT the prices (the mock's
 * are «live» and the engine's the bundled table), the clock, the log's lines beyond its first and last kind, or how many requests a batch sends (the mock sends up to six at a
 * time, the engine as many as its slots). It is written only at the stable points of a story (nothing in flight that is not named), so a tick more or less cannot move a line.
 * The photos a LIBRARY video takes are not written: the engine's planner draws their number by the seed (collages of 2 to 4, slides of 5 to 7), the mock's plan is fixed.
 */
function launchFacts(value: unknown): Record<string, unknown> {
  const v = objectOf(value);
  const list = (items: unknown): Record<string, unknown>[] => (Array.isArray(items) ? items.map((item) => objectOf(item)) : []);
  const hold = v.paidHold === null || v.paidHold === undefined ? null : objectOf(v.paidHold);
  const free = v.freeHold === null || v.freeHold === undefined ? null : objectOf(v.freeHold);
  const open = (counts: unknown): boolean => counts !== undefined && Number(objectOf(counts).requests) > 0;
  return {
    launchId: v.launchId,
    status: v.status,
    paused: v.paused === null ? null : objectOf(v.paused).cause,
    // An internal hold says which kind it is (S4.6r: a launch's own check has no exit but «Стоп», a failed job is retried by «Продолжить»), not the job's words: those are the engine's own.
    paidHold:
      hold === null
        ? null
        : hold.reason === "network" || hold.reason === "price-unavailable"
          ? { reason: hold.reason, retryPending: objectOf(hold.detail).nextAt !== null }
          : hold.reason === "internal"
            ? { reason: hold.reason, kind: objectOf(hold.detail).kind }
            : hold.reason,
    freeHold: free === null ? null : { reason: free.reason, exportReason: objectOf(free.detail).exportReason },
    resumeBlockedBy: v.resumeBlockedBy,
    planVideos: objectOf(v.plan).videos,
    spent: v.spentMicros === 0 ? "none" : "some",
    inFlight: open(v.inFlight),
    unsettled: open(v.unsettled),
    waitingMusic: v.waitingMusic,
    avatars: list(v.avatars).map((a) => ({
      avatarId: a.avatarId,
      phase: a.phase,
      waiting: a.waiting === null ? null : objectOf(a.waiting).reason,
      skipped: a.skipped === null ? null : objectOf(a.skipped).reason,
      videos: a.videos,
      photos: a.photos,
      waitingMusic: a.waitingMusic,
      dropped: a.dropped,
      sceneSetId: a.sceneSetId,
      // The revision is the set file's count of writes (the engine's compose makes it 3, an approval 4): that a set is named with one is the contract, its number is not.
      setRevision: a.setRevision === null ? null : "<n>",
      scenes: a.scenes,
      continuePhotos: a.continuePhotos,
    })),
  };
}

/** `launchFacts` for each autopilot answer a story reads at a stable point. */
function autopilotDetail(type: string, result: Record<string, unknown>): Record<string, unknown> {
  const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map((item) => objectOf(item)) : []);
  if (type === "autopilot.list") {
    return { launches: list(result.launches).map((l) => ({ launchId: l.launchId, status: l.status, avatarCount: l.avatarCount, videosDone: l.videosDone, videosPlanned: l.videosPlanned, spent: l.spentMicros === 0 ? "none" : "some" })), unreadable: list(result.unreadable) };
  }
  if (type === "autopilot.get") {
    const log = list(result.log);
    const videos = list(result.videos);
    const states: Record<string, number> = {};
    for (const video of videos) states[String(video.state)] = (states[String(video.state)] ?? 0) + 1;
    return {
      launch: launchFacts(result.launch),
      firstLogKind: log[0]?.kind ?? null,
      lastLogKind: log.at(-1)?.kind ?? null,
      videos: states,
      finishedVideosHaveATrack: videos.filter((v) => v.state === "done").every((v) => v.track !== null && v.videoId !== null),
      dropReasons: [...new Set(videos.flatMap((v) => (v.dropReason === null ? [] : [String(v.dropReason)])))].sort(),
      removed: videos.filter((v) => v.removed === true).length,
      published: result.published ?? null,
    };
  }
  return { launch: launchFacts(result.launch), ...(result.draw === undefined ? {} : { draw: result.draw }) };
}

/**
 * The least a launch's answer must say at a point where it is MOVING (right after a click that lets it go on): where it stands and where its rows stand. How far a row has drawn, or what
 * is in flight, belongs to a tick more or less.
 */
function launchBrief(value: unknown): Record<string, unknown> {
  const v = objectOf(value);
  const rows = Array.isArray(v.avatars) ? v.avatars.map((a) => objectOf(a)) : [];
  return { launchId: v.launchId, status: v.status, paused: v.paused === null ? null : objectOf(v.paused).cause, hold: v.paidHold === null ? null : objectOf(v.paidHold).reason, phases: rows.map((a) => a.phase) };
}

/** `launchBrief` for an autopilot command's answer (`draw` too, when it carries one). */
function autopilotBrief(result: Record<string, unknown>): Record<string, unknown> {
  return { launch: launchBrief(result.launch), ...(result.draw === undefined ? {} : { draw: result.draw }) };
}

/**
 * An answer as a line. `running` (S4.8): an autopilot answer is written as `autopilotDetail` says, for a story that reads a launch that runs; `"brief"` as `autopilotBrief` says, for an
 * answer given while the launch moves.
 */
export function answerLine(type: string, answer: Answer, norm: Normalizer, running: boolean | "brief" | "card" = false): string {
  if (!answer.ok) {
    const { code, detail, issues, exportReason, musicReason, captionIssue, photoReason, categoryReason, sceneReason, sceneId, launchReason } = answer.error;
    // The transport's VALIDATION text is the engine's or the client's own words: only its code is compared. A music error's
    // detail names times of the rig's own clock: its code and its cause are compared.
    // S4.8 (`running`): a launch's refusals say sums and sentences of the engine's own (the remaining worst case, the key's state); the code and the reason are the contract.
    // S4.6p: a launch the price is asked for is told in each engine's own words (which launch, which avatar); its code is the contract.
    // S4.10 fix D: an IN_FLIGHT given to a command sent while a launch runs names the job in each engine's own words; its code is the contract.
    const text = code === "VALIDATION" || (running !== false && code === "IN_FLIGHT") || code.startsWith("MUSIC_") || (running && type.startsWith("autopilot.")) || type === "runs.estimateImages" ? undefined : detail;
    return `< error ${code} ${compact(
      norm.value({
        ...(text === undefined ? {} : { detail: text }),
        ...(issues === undefined ? {} : { issues }),
        ...(exportReason === undefined ? {} : { exportReason }),
        ...(musicReason === undefined ? {} : { musicReason }),
        ...(captionIssue === undefined ? {} : { captionIssue }),
        ...(photoReason === undefined ? {} : { photoReason }),
        ...(categoryReason === undefined ? {} : { categoryReason }),
        ...(sceneReason === undefined ? {} : { sceneReason }),
        ...(sceneId === undefined ? {} : { sceneId }),
        ...(launchReason === undefined ? {} : { launchReason }),
      }),
    )}`;
  }
  if (type === "montages.textPreview") {
    // The box is the rasteriser's in the engine and an estimate in the mock: only that it is a box inside the frame is compared.
    const { previewId, width, height } = answer.result;
    if (!Number.isInteger(width) || !Number.isInteger(height) || Number(width) < 1 || Number(height) < 1 || Number(width) > FRAME_W || Number(height) > FRAME_H) {
      throw new Error(`a text preview's box is not whole pixels inside the frame: ${String(width)}x${String(height)}`);
    }
    return `< ok ${compact(norm.value({ previewId, width: "<px>", height: "<px>" }))}`;
  }
  if (type === "videos.list") {
    const listed = Array.isArray(answer.result.videos) ? answer.result.videos : [];
    return `< ok ${compact(norm.value({ videos: listed.map(videoLine) }))}`;
  }
  if (type === "videos.get") {
    // The summary as the list writes it, then what 3e.2 added to it (`videoFactsLine`).
    const video = answer.result.video;
    return `< ok ${compact(norm.value({ video: videoLine(video), facts: videoFactsLine(video) }))}`;
  }
  if (type === "avatars.list") {
    // The grid's avatars as `avatarLine` writes them (3e.2: the usage when it is not ok), and how many could not be listed.
    const listed = Array.isArray(answer.result.avatars) ? answer.result.avatars : [];
    return `< ok ${compact({ avatars: listed.map((a) => norm.value(avatarLine(a))), unreadableTotal: answer.result.unreadableTotal })}`;
  }
  if (type === "music.status") return `< ok music ${compact(musicLine(answer.result))}`;
  if (type === "music.refresh" || type === "music.recoverQuotaLog") return `< ok music ${compact(musicLine(answer.result.status))}`;
  if (type === "photos.list") {
    const listed = Array.isArray(answer.result.photos) ? answer.result.photos : [];
    // Only the photos that are not free are written: a free one is `used`, `reserved` and `rejected` false and `eligible` true.
    const held = listed
      .map((photo) => objectOf(photo))
      .filter((p) => p.used === true || p.reserved === true || p.rejected === true || p.eligible === false)
      .map((p) => compact(norm.value({ photoId: p.photoId, used: p.used, usedIn: p.usedIn, reserved: p.reserved, rejected: p.rejected, eligible: p.eligible })))
      .sort();
    // The order of the whole list is what the photo grid shows: written as the seeded photos' numbers, runs as `22..1`.
    const order = orderOf(listed.map((photo) => norm.value(objectOf(photo).photoId, "photoId")));
    // S4.P2: where the next page starts and how many photos lie beyond this one are written only when there is a next page, so every older line stays as it was.
    const next = typeof answer.result.nextCursor === "string" ? decodePhotoCursor(answer.result.nextCursor) : null;
    const paging = next === null && !(typeof answer.result.remainingTotal === "number" && answer.result.remainingTotal > 0) ? {} : { next: next === null ? null : norm.value(next.photoId, "photoId"), remainingTotal: answer.result.remainingTotal };
    return [`< ok photos ${compact({ count: listed.length, free: listed.length - held.length, skippedTotal: answer.result.skippedTotal, order, ...paging })}`, ...held.map((s) => `  ${s}`)].join("\n");
  }
  if (type === "runs.estimateImages") {
    // S4.6p: the figures are each engine's own prices (the mock's fixed image price, the engine's bundled table, as for every estimate). What both are bound to say: the photos the
    // price is for, that the figure is ordered (expected within worst), that it is a price (above zero) exactly when there are photos, and that it names its price source.
    const { photos, estimate } = answer.result;
    const figures = objectOf(estimate);
    const expected = Number(figures.expectedMicros);
    const worst = Number(figures.worstMicros);
    return `< ok images ${compact({ photos, ordered: expected <= worst, priced: worst > 0, source: typeof figures.prices === "string" })}`;
  }
  if (type === "engine.snapshot") return snapshotLine(answer.result, norm);
  if (type === "media.list") {
    for (const media of Array.isArray(answer.result.media) ? answer.result.media : []) {
      const id = objectOf(media).mediaId;
      if (typeof id === "string") norm.registerMedia(id);
    }
    return `< ok ${compact(norm.value(answer.result))}`;
  }
  if (type === "settings.setExportPath") {
    // A pick answers the settings too, whose folder paths are the rig's own (a temp dir, the mock's home): only the folder's identity
    // (as `root#N`, in order of appearance, so a folder met again reads the same) and the counts are compared.
    if (answer.result.picked !== true) return `< ok ${compact(answer.result)}`;
    const { rootId, resolved, elsewhere } = answer.result;
    return `< ok ${compact({ picked: true, rootId: typeof rootId === "string" ? norm.register("root", rootId) : rootId, resolved, elsewhere })}`;
  }
  if (type === "settings.setModels" || type === "settings.setCameraRealism" || type === "settings.get") {
    // The settings carry the rig's own paths, key tail and age-check mode (the mock's home against a temp dir): only the fields the
    // image-model story is about are compared.
    const { imageModel, imageQuality, textModel, cameraRealism } = answer.result;
    return `< ok ${compact({ imageModel, imageQuality, textModel, cameraRealism })}`;
  }
  if (type === "photos.setRejected") {
    // The fixtures' own run, date and QA verdicts differ by construction: what is compared is the photo's state.
    const p = objectOf(answer.result.photo);
    return `< ok ${compact(norm.value({ photo: { photoId: p.photoId, used: p.used, usedIn: p.usedIn, reserved: p.reserved, rejected: p.rejected, eligible: p.eligible } }))}`;
  }
  if (running !== false && type === "runs.list") {
    // S4.10 fix D, a story that reads the runs while a launch runs: which run is a slice of the launch (`launchId` present) and how many photos it draws. Its progress, money and times
    // are each engine's own.
    const runs = Array.isArray(answer.result.runs) ? answer.result.runs.map((run) => objectOf(run)) : [];
    // A run id is not one of the aliased kinds (an older line may write it as it came), so it is named here, in order of appearance.
    return `< ok ${compact(norm.value({ runs: runs.map((r) => ({ runId: norm.register("run", String(r.runId)), avatarId: r.avatarId, total: r.total, launch: r.launchId !== undefined })) }))}`;
  }
  if (running !== false && type === "scenes.get") {
    // S4.10 fix D: the avatar's set as the owner sees it while a launch runs: its status, whether the launch holds it, and how many scenes are there and written.
    const set = answer.result.sceneSet === null ? null : objectOf(answer.result.sceneSet);
    const scenes = set === null || !Array.isArray(set.scenes) ? [] : set.scenes.map((scene) => objectOf(scene));
    const view = set === null ? null : { sceneSetId: set.sceneSetId, status: set.status, launch: set.launchId !== undefined, scenes: scenes.length, written: scenes.filter((s) => s.text !== null).length };
    return `< ok ${compact(norm.value({ sceneSet: view, unreadable: answer.result.unreadable }))}`;
  }
  if (type.startsWith("autopilot.")) {
    const detailed = running !== false && type !== "autopilot.removeUnreadable" && type !== "autopilot.estimate";
    const facts = running === "brief" && "launch" in answer.result ? autopilotBrief(answer.result) : detailed ? autopilotDetail(type, answer.result) : autopilotFacts(type, answer.result, running === "card");
    return `< ok ${compact(norm.value(facts))}`;
  }
  if (type === "videos.setPublished") {
    // The time of the mark is the engine's clock or the mock's: that the video is marked is compared.
    const video = objectOf(answer.result.video);
    return `< ok ${compact(norm.value({ videoId: video.videoId, published: typeof video.publishedAt === "string" }))}`;
  }
  if (type === "media.setForAutopilot") {
    const media = objectOf(answer.result.media);
    return `< ok ${compact(norm.value({ mediaId: media.mediaId, forAutopilot: media.forAutopilot === true }))}`;
  }
  return `< ok ${compact(norm.value(answer.result))}`;
}

/**
 * What an autopilot answer is bound to say (Stage 4, S4.1): the facts that are the contract's and the plan's, not the prices (the mock's are «live» and the engine's the
 * bundled table, as for every estimate), not the clock (the times of a hold, a pause or a log line), and not the spend and the progress of a launch (the mock holds a canned
 * mid-run state until S4.8). A story passes its own plan seed, which the preview echoes.
 */
function autopilotFacts(type: string, result: Record<string, unknown>, card = false): Record<string, unknown> {
  const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map((item) => objectOf(item)) : []);
  const launch = (value: unknown): Record<string, unknown> => {
    const v = objectOf(value);
    return {
      launchId: v.launchId,
      status: v.status,
      paused: v.paused === null ? null : objectOf(v.paused).cause,
      plan: v.plan,
      acceptedMicros: v.acceptedMicros,
      resumeBlockedBy: v.resumeBlockedBy,
      hold: v.paidHold === null ? null : objectOf(v.paidHold).reason,
      // The avatars' phases are written where a transition is the point (a start, a pause, a resume, the review hand-off); a stopped or a read launch shows its canned rows only in the mock.
      ...(type === "autopilot.stop" || type === "autopilot.get" ? {} : { avatars: list(v.avatars).map((a) => ({ avatarId: a.avatarId, phase: a.phase })) }),
    };
  };
  if (type === "autopilot.estimate") {
    const p = objectOf(result.preview);
    return {
      preview: {
        planSeed: p.planSeed,
        avatars: list(p.avatars),
        totals: p.totals,
        blockers: p.blockers,
        autoRefresh: objectOf(p.music).autoRefresh,
        // S4.10 fix B, only for a story that asks for the plan card's figures (`Transcript.callCard`): that they are FILLED, not what they are. The counts of tracks, the balance in micro-dollars and
        // the free bytes are each rig's own (the engine's bundled tables and statfs, the mock's canned figures); the card is bound to say that a stored music key and stored trends give
        // candidates, an OpenRouter key a balance and a usable export folder its free bytes.
        ...(card ? { card: { candidates: Number(objectOf(p.music).candidates) > 0, balance: p.balance !== null, freeBytes: objectOf(p.disk).freeBytes !== null } } : {}),
      },
    };
  }
  if (type === "autopilot.list") {
    const summaries = list(result.launches).map((l) => ({ launchId: l.launchId, status: l.status, avatarCount: l.avatarCount, videosPlanned: l.videosPlanned }));
    return { launches: summaries, unreadable: list(result.unreadable) };
  }
  if (type === "autopilot.get") {
    const log = list(result.log);
    return { launch: launch(result.launch), firstLogKind: log[0]?.kind ?? null };
  }
  if (type === "autopilot.removeUnreadable") return result;
  return { launch: launch(result.launch), ...(result.draw === undefined ? {} : { draw: result.draw }) };
}

/** What a rig gives the transcript: commands, the events so far, and the two moves of time. */
export interface Recorded {
  send(type: string, payload: unknown): Promise<Answer>;
  events(): EventMessage[];
  advance(step: "progress" | "saving" | "end"): Promise<void>;
  settle(): Promise<void>;
  /** Stage 4 (S4.8): lets a RUNNING launch move a little: the mock runs the next task of its clock, the real engine gets a few milliseconds. Both parity rigs have it; a stub need not. */
  pump?(): Promise<void>;
  /** Stage 4 (S4.8): what the rig can tell of a launch that did not move, written into the error of `untilLaunch`. Only the real rig has it. */
  diagnose?(): Promise<string>;
}

export class Transcript {
  readonly #lines: string[] = [];
  readonly #rig: Recorded;
  readonly norm: Normalizer;
  readonly #progress = new ProgressInvariants();
  readonly #importProgress = new ImportProgressInvariants();
  /** The renders announced as waiting for a slot, in order (as aliases): what the window shows as «В очереди». */
  readonly #queued: string[] = [];
  #seen: number;
  /** The commands sent with `start`, and how many of them have answered. */
  #started = 0;
  #answered = 0;

  constructor(rig: Recorded, norm: Normalizer) {
    this.#rig = rig;
    this.norm = norm;
    // What happened while the engine was being set up is not part of any scenario.
    this.#seen = rig.events().length;
  }

  /** The events that came since the last look, in order. */
  #drain(): void {
    const all = this.#rig.events();
    for (const event of all.slice(this.#seen)) {
      // The transcript leaves a render's `done` out; the rules its numbers must satisfy are checked here, on both engines.
      if (event.type === "job.progress" && event.payload.kind === "render") {
        this.#progress.check(event.payload);
        if (event.payload.queued === true) this.#queued.push(String(objectOf(this.norm.value({ jobId: event.payload.jobId })).jobId));
      }
      // An import's numbers count bytes copied; the rules they must satisfy are checked here too, on both engines.
      if (event.type === "job.progress" && event.payload.kind === "import") {
        this.#importProgress.check(event.payload);
        if (event.payload.queued === true) this.#queued.push(String(objectOf(this.norm.value({ jobId: event.payload.jobId })).jobId));
      }
      const line = eventLine(event, this.norm);
      if (line !== null) this.#lines.push(line);
    }
    this.#seen = all.length;
  }

  /** Sends a command: the command, the events it caused before it answered, then its answer. */
  async call(type: string, payload: unknown): Promise<Answer> {
    this.#drain();
    this.#lines.push(`> ${type} ${compact(this.norm.value(payload))}`);
    const answer = await this.#rig.send(type, payload);
    this.#drain();
    this.#lines.push(answerLine(type, answer, this.norm));
    return answer;
  }

  /**
   * Stage 4 (S4.10 fix B): `autopilot.estimate` with the plan card's filled figures written as unitless facts (`candidates > 0`, `balance !== null`, `freeBytes !== null`), beside the facts
   * every estimate writes. Only the stories that ask for it carry them, so the older transcripts are unchanged.
   */
  async callCard(payload: unknown): Promise<Answer> {
    this.#drain();
    this.#lines.push(`> autopilot.estimate ${compact(this.norm.value(payload))}`);
    const answer = await this.#rig.send("autopilot.estimate", payload);
    this.#seen = this.#rig.events().length;
    this.#lines.push(answerLine("autopilot.estimate", answer, this.norm, "card"));
    return answer;
  }

  /**
   * Stage 4 (S4.8): sends an autopilot command to a launch that RUNS. The command, then its answer as `autopilotDetail` writes it; the events the launch causes meanwhile are not
   * written (the engine's free steps and the mock's passes announce and render at their own pace, and what they announce is not what a story is about).
   */
  async callLaunch(type: string, payload: unknown, options: { brief?: boolean; written?: unknown } = {}): Promise<Answer> {
    this.#drain();
    // `written` is what the transcript says was sent where the payload carries a figure that is the engine's own (a scene set's revision, a sum): the revision the window saw is a
    // number of the set file's writes, not of the contract.
    this.#lines.push(`> ${type} ${compact(this.norm.value(options.written ?? payload))}`);
    const answer = await this.#rig.send(type, payload);
    this.#seen = this.#rig.events().length;
    this.#lines.push(answerLine(type, answer, this.norm, options.brief === true ? "brief" : true));
    return answer;
  }

  /**
   * Stage 4 (S4.8): lets a launch that RUNS go on until `autopilot.get` says `want` of its view (or until `ms` of wall time pass, which fails the scenario), and writes one note. The default stays under the parity test's own 60 s timeout, so a hung engine fails with this message rather than the runner's. What
   * happens on the way is not written; the story reads the launch at the point it waited for.
   */
  async untilLaunch(launchId: string, what: string, want: (launch: Record<string, unknown>) => boolean, ms = 45_000): Promise<void> {
    const pump = this.#rig.pump;
    if (pump === undefined) throw new Error("this rig cannot let a launch run");
    this.#drain();
    const deadline = Date.now() + ms;
    for (let i = 0; ; i++) {
      const answer = await this.#rig.send("autopilot.get", { launchId });
      const launch = answer.ok ? objectOf(answer.result.launch) : null;
      if (launch !== null && want(launch)) break;
      if (Date.now() > deadline || i > 20_000) {
        const seen = launch === null ? "an error" : `${String(launch.status)}, ${JSON.stringify(Array.isArray(launch.avatars) ? launch.avatars.map((a) => objectOf(a).phase) : [])}, hold ${JSON.stringify(launch.paidHold)}`;
        // What the rig can tell of a launch that did not move (its jobs' ends, the requests, the run journals): a CI log that holds only this error still says why.
        const diagnose = this.#rig.diagnose;
        const told = diagnose === undefined ? "" : await diagnose.call(this.#rig).catch((error: unknown) => `the rig could not tell why (${error instanceof Error ? error.message : String(error)})`);
        const refused = answer.ok ? "" : `; autopilot.get answered ${JSON.stringify(answer.error).slice(0, 400)}`;
        throw new Error(`the launch never reached ${what} (it said ${seen}${refused})${told === "" ? "" : `\n${told}`}`);
      }
      await pump.call(this.#rig);
    }
    this.#seen = this.#rig.events().length;
    this.#lines.push(`# the launch reached: ${what}`);
  }

  /**
   * Sends commands WITHOUT awaiting one before the next (an editor's autosave bursts): the commands in the order sent, the events
   * they caused in the order they came, each answer in the order sent, and the order the answers ARRIVED in. Between the events and
   * the answers of different commands the engine and the mock interleave differently (the engine writes a file per save; the mock
   * answers at once), so that interleaving is not written; what is checked, on both, is that an answer never arrives before the
   * `montage.changed` of every command up to it that succeeded (an echo comes first).
   */
  async burst(calls: readonly { type: string; payload: unknown }[]): Promise<Answer[]> {
    this.#drain();
    calls.forEach((call, i) => this.#lines.push(`> [${i}] ${call.type} ${compact(this.norm.value(call.payload))}`));
    const arrival: number[] = [];
    const seenAtArrival: number[] = [];
    const before = this.#rig.events().length;
    const echoes = (): number => this.#rig.events().slice(before).filter((e) => e.type === "montage.changed").length;
    const answers = await Promise.all(
      calls.map(async (call, i) => {
        const answer = await this.#rig.send(call.type, call.payload);
        arrival.push(i);
        seenAtArrival[i] = echoes();
        return answer;
      }),
    );
    this.#drain();
    let succeeded = 0;
    answers.forEach((answer, i) => {
      // Only the commands that change a draft send a `montage.changed`.
      if (answer.ok && /^montages\.(create|save|delete)$/.test(calls[i]?.type ?? "")) succeeded++;
      if ((seenAtArrival[i] ?? 0) < succeeded) throw new Error(`the answer of command [${i}] arrived before the montage.changed of a command up to it`);
      this.#lines.push(`< [${i}] ${answerLine(calls[i]?.type ?? "", answer, this.norm).slice(2)}`);
    });
    this.#lines.push(`~ answers arrived in order ${arrival.join(",")}`);
    return answers;
  }

  /**
   * Sends a command and does NOT wait for its answer (a text preview held in the lane): the command is written now, its answer
   * where it ARRIVES, in the order of arrival, which is what a story about a stale preview is bound to. Returns its number.
   */
  start(type: string, payload: unknown): number {
    this.#drain();
    const n = this.#started++;
    this.#lines.push(`> [${n}] ${type} ${compact(this.norm.value(payload))}`);
    void this.#rig.send(type, payload).then((answer) => {
      this.#drain();
      this.#answered++;
      this.#lines.push(`< [${n}] ${answerLine(type, answer, this.norm).slice(2)}`);
    });
    return n;
  }

  /** Lets everything that can happen without time or the disk happen: every promise already settled has run its continuations. */
  async quiesce(): Promise<void> {
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  /** Waits until `count` of the commands sent with `start` have answered (real I/O may be between a release and an answer). */
  async untilAnswered(count: number, ms = 15_000): Promise<void> {
    const from = Date.now();
    while (this.#answered < count) {
      if (Date.now() - from > ms) throw new Error(`timed out waiting for ${count} answers, got ${this.#answered}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    this.#drain();
  }

  async advance(step: "progress" | "saving" | "end"): Promise<void> {
    this.#drain();
    await this.#rig.advance(step);
    this.#lines.push(`~ advance ${step}`);
    this.#drain();
  }

  async settle(): Promise<void> {
    this.#drain();
    await this.#rig.settle();
    this.#lines.push("~ settle");
    this.#drain();
  }

  /** After the rig was stopped: whatever the scenario left running ended now, and its events are written under a marker. */
  finish(): void {
    const mark = this.#lines.length;
    this.#drain();
    if (this.#lines.length > mark) this.#lines.splice(mark, 0, "~ end of scenario");
  }

  /** The jobs announced `queued` so far, in order (events not yet drained are read first). */
  announcedQueued(): string[] {
    this.#drain();
    return [...this.#queued];
  }

  /** A line the scenario writes for its reader. */
  note(text: string): void {
    this.#lines.push(`# ${text}`);
  }

  /** Runs setup that is not part of what is compared (twenty renders to fill a queue): its lines are dropped. */
  async quiet(work: () => Promise<void>): Promise<void> {
    this.#drain();
    const mark = this.#lines.length;
    await work();
    this.#drain();
    this.#lines.length = mark;
  }

  /** The lines, with a run of `mid` progress events collapsed to one (the engine and the mock step differently). */
  lines(): string[] {
    const out: string[] = [];
    for (const line of this.#lines.flatMap((l) => l.split("\n"))) {
      const isMid = line.startsWith("event job.progress ") && line.endsWith(`"phase":"mid"}`);
      if (isMid && out.at(-1) === line) continue;
      out.push(line);
    }
    return out;
  }
}

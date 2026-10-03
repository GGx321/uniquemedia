import type { EngineError, EventMessage } from "../../../shared/engine";
import { FRAME_H, FRAME_W } from "../../../shared/montage";
import { ProgressInvariants } from "./progress";

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
export const COVERED_EVENTS: ReadonlySet<string> = new Set(["job.progress", "job.done", "job.failed", "job.cancelled", "video.changed", "montage.changed", "avatar.changed", "export.status", "music.changed"]);

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
  "text previews (3d.1b): the engine draws a caption with its rasteriser, the mock does not: its box is the engine's own layout over an arithmetic width (0.55 em a character, no font) and its picture a placeholder PNG of that box. So `width` and `height` are written as `<px>` after checking they are whole pixels inside the frame, and the picture's bytes are not compared (that they are a PNG of the answered box is the mock's own test). The mock draws every well-formed emoji; the engine refuses a cluster its font lacks (`emoji-missing`), so no story uses one it cannot draw. The time one drawing takes is not modelled by the suite: a rig's text lane is held and let go by the scenario",
  "music list and peaks (3d.1b): the real rig's store holds tracks it downloaded from a fake CDN, the mock's are seeded from the same fixture list; both answer through the track store's own highlight and waveform rules (studio/shared/music/trackShape.ts). The mock models no disk for a track: no torn envelope file, no track deleted under a live record (the engine's `peaks` is then NOT_FOUND while `list` still lists it, until a restart), no cover file: those are the store's own unit tests' business, and no story deletes the music folder after storing tracks. The cap of 100 listed tracks is not played: the real rig would have to download 101 tracks; it is pinned by the mock's own test and the track store's",
  "a video's first clip (3e.2): the engine's record holds the RESOLVED spec (every focus filled, the stand-in point where no face was found), the mock's the draft's (null there); `videos.get` writes the clip as its kind, layout and photos, never its focus, and the older stories' lines leave out the title, the first clip and the track id (no older golden line changed)",
  "usage (3e.2): the mock has no disk, so an avatar's broken records or marks are the usage it was seeded with (a renderer test's state) and a recovery clears its own reason; the engine moves or copies files. No story breaks a file: the suite plays the recoveries of a sound avatar, which change nothing on either. `photos.rebuildRejected`'s `kept` is the engine's count of readable log lines and the mock's of rejected photos: equal for a log of one mark per photo, which is what the story writes",
  "music (3c.6): the mock keeps its quota log and its list as numbers on its own clock, so the times a status carries (`listFetchedAt`, `nextFreeAt`) are written as set or null, a refresh's steps are not written, and a music error's detail (it names a time) is not compared: its code and its `musicReason` are. No story sends a flashapi request: the real rig's flashapi refuses every call",
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
  previewId: "preview",
  clipId: "clip",
  layerId: "layer",
};
const ID_LIST_KINDS: Readonly<Record<string, string>> = { photoIds: "photo", usedIn: "video" };

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
  const { title: _title, firstClip: _firstClip, ...rest } = objectOf(video);
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

/** The avatar as the grid shows it, less what differs by construction (the descriptor text, the date). */
function avatarLine(avatar: unknown): Record<string, unknown> {
  const a = objectOf(avatar);
  return { avatarId: a.avatarId, name: a.name, status: a.status, photoCount: a.photoCount, videoCount: a.videoCount, eligibleUnusedCount: a.eligibleUnusedCount };
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

/** An answer as a line. */
export function answerLine(type: string, answer: Answer, norm: Normalizer): string {
  if (!answer.ok) {
    const { code, detail, issues, exportReason, musicReason, captionIssue } = answer.error;
    // The transport's VALIDATION text is the engine's or the client's own words: only its code is compared. A music error's
    // detail names times of the rig's own clock: its code and its cause are compared.
    const text = code === "VALIDATION" || code.startsWith("MUSIC_") ? undefined : detail;
    return `< error ${code} ${compact(
      norm.value({
        ...(text === undefined ? {} : { detail: text }),
        ...(issues === undefined ? {} : { issues }),
        ...(exportReason === undefined ? {} : { exportReason }),
        ...(musicReason === undefined ? {} : { musicReason }),
        ...(captionIssue === undefined ? {} : { captionIssue }),
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
    return [`< ok photos ${compact({ count: listed.length, free: listed.length - held.length, skippedTotal: answer.result.skippedTotal, order })}`, ...held.map((s) => `  ${s}`)].join("\n");
  }
  if (type === "engine.snapshot") return snapshotLine(answer.result, norm);
  if (type === "settings.setExportPath") {
    // A pick answers the settings too, whose folder paths are the rig's own (a temp dir, the mock's home): only the folder's identity
    // (as `root#N`, in order of appearance, so a folder met again reads the same) and the counts are compared.
    if (answer.result.picked !== true) return `< ok ${compact(answer.result)}`;
    const { rootId, resolved, elsewhere } = answer.result;
    return `< ok ${compact({ picked: true, rootId: typeof rootId === "string" ? norm.register("root", rootId) : rootId, resolved, elsewhere })}`;
  }
  if (type === "photos.setRejected") {
    // The fixtures' own run, date and QA verdicts differ by construction: what is compared is the photo's state.
    const p = objectOf(answer.result.photo);
    return `< ok ${compact(norm.value({ photo: { photoId: p.photoId, used: p.used, usedIn: p.usedIn, reserved: p.reserved, rejected: p.rejected, eligible: p.eligible } }))}`;
  }
  return `< ok ${compact(norm.value(answer.result))}`;
}

/** What a rig gives the transcript: commands, the events so far, and the two moves of time. */
export interface Recorded {
  send(type: string, payload: unknown): Promise<Answer>;
  events(): EventMessage[];
  advance(step: "progress" | "saving" | "end"): Promise<void>;
  settle(): Promise<void>;
}

export class Transcript {
  readonly #lines: string[] = [];
  readonly #rig: Recorded;
  readonly norm: Normalizer;
  readonly #progress = new ProgressInvariants();
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

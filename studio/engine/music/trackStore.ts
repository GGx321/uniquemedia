import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Id, MAX_LISTED_TRACKS, type TrackSummary } from "../../shared/engine";
import { fsyncDir, isTempName, tempSiblingPath, writeFileAtomic, writeFileDurable, writeJsonAtomic } from "../library/durableFs";
import { renameWithRetry } from "../library/renameRetry";
import { checkCdnUrl } from "./cdnPolicy";
import type { CdnTransport } from "./cdnTransport";
import { decodeAudio, DecodeError, inspectStreams, type DecodeOptions, type DecodeResult, PEAK_STEP_MS } from "./decodeCheck";
import { downloadCapped, DownloadError } from "./downloadCapped";
import { probeMp4Audio } from "./mp4aProbe";
import { withoutLongPathPrefix } from "./quotaLedger";
import { TrackUnavailableError, type RenderTrack, type RenderTrackSource } from "./renderTrack";
import { SinkError, type FetchedList, type MusicListSink } from "./service";
import { trackForbiddenStrings } from "./trackTags";
import {
  COVER_EXTENSIONS,
  EnvelopeSchema,
  expiresAtFor,
  ListRecordSchema,
  MAX_RECORDED_TRACKS,
  normaliseHighlights,
  toSummary,
  windowPeaks,
  type CoverExtension,
  type ListRecord,
  type TrackEntry,
} from "./trackRecord";

// The track store (3c.4): the persisting `MusicListSink` that turns `music.refresh` on. Layout, under `userData/music/`:
//
//   lists/current.json     the list record (trackRecord.ts): written whole (temp, fsync, rename) BEFORE any download
//   tracks/<id>.m4a        one verified AAC file per track; served as `studio-media://track/<id>`
//   covers/<id>.<ext>      jpg, png or webp, the extension read from the bytes; `studio-media://cover/<id>`
//   peaks/<id>.json        the 50 ms waveform envelope `music.peaks` serves
//
// The request that produced the list is spent and its signed URLs live 104 to 108 hours, so the record goes to disk first
// (with each pending URL and its `expiresAt`), and then every track and cover is downloaded at refresh time, one at a
// time, under invariant 31: the URL passes the host policy before the request and the transport connects only to a public
// address (`cdnTransport.ts`); no redirect is followed; a track is at most 25 MB, a cover 2 MB; a track is stored only
// after the box walker read exactly one AAC stream and a bounded ffmpeg decode proved audio of about the claimed length.
// A file becomes visible only by a rename of a complete, verified temp file (a dot-prefixed `.tmp` sibling that the
// media protocol never serves and the next start sweeps). A path is built only from an `Id` and a fixed extension: nothing
// from the network is ever a file name. A track that fails is recorded as failed with a short reason and the rest go on;
// once its download ends an entry keeps no URL.

export const TRACK_MAX_BYTES = 25 * 1024 * 1024;
export const COVER_MAX_BYTES = 2 * 1024 * 1024;
/** The waveform file is a few KiB (a 3 minute track is 3 600 values); past this it is not ours. */
const ENVELOPE_MAX_FILE_BYTES = 256 * 1024;

export interface TrackStoreDeps {
  /** `userData/music`. */
  dir: string;
  transport: CdnTransport;
  clock: () => number;
  /** One line at a time. Names hosts and reason codes only: never a URL, a path or a key. */
  log: (line: string) => void;
  /** The bounded decode; ffmpeg by default (a test passes a fast stand-in). */
  decode?: (options: DecodeOptions) => Promise<DecodeResult>;
  /** The kinds of stream ffmpeg sees in a file, asked again at every render; `inspectStreams` by default (a test passes a stand-in). */
  inspect?: (path: string, signal: AbortSignal) => Promise<readonly string[]>;
  /** Removes a file; `fs.rm` by default. A test passes one that fails. */
  removeFile?: (path: string) => Promise<void>;
  /** Lowers the limits in a test; never passed in the app. */
  limits?: { timeoutMs?: number; idleMs?: number };
}

type Audio = TrackEntry["audio"];
type Cover = TrackEntry["cover"];

/** A cover's kind from its first bytes, or null when it is not a JPEG, a PNG or a WebP. The URL and the content type are never consulted. */
function sniffCover(bytes: Uint8Array): CoverExtension | null {
  const at = (offset: number, ...values: number[]): boolean => values.every((value, i) => bytes[offset + i] === value);
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

const URL_TEXT = /https?:(?:\\?\/|\\u002[fF]){2}(?:\\.|[^\s"\\])*/gi;

/**
 * `text` without any URL: a signed one in a record set aside would sit on disk long after it stopped working. JSON is
 * walked by its values (so escaped slashes and any key name are covered) and written again; anything else is scrubbed as
 * text, through a quote and an escaped slash, up to the whitespace or the double quote that ends a URL.
 */
function scrubUrls(text: string): string {
  try {
    const walk = (value: unknown): unknown => {
      if (typeof value === "string") return value.replace(URL_TEXT, "[url]");
      if (Array.isArray(value)) return value.map(walk);
      if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key.replace(URL_TEXT, "[url]"), walk(inner)]));
      return value;
    };
    return JSON.stringify(walk(JSON.parse(text)));
  } catch {
    return text.replace(URL_TEXT, "[url]");
  }
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Makes a folder and every level it had to create durable: the new entries are synced in their parents (a no-op on Windows). */
async function mkdirDurable(folder: string): Promise<void> {
  const made = await mkdir(folder, { recursive: true });
  if (made === undefined) return;
  const first = withoutLongPathPrefix(made);
  for (let level = folder; ; level = dirname(level)) {
    await fsyncDir(dirname(level)).catch(() => undefined);
    if (level === first || dirname(level) === level) break;
  }
}

async function isRegularFileOfSize(path: string, bytes: number): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === bytes;
  } catch {
    return false;
  }
}

const countPending = (record: ListRecord): number => record.tracks.reduce((sum, entry) => sum + Number(entry.audio.state === "pending") + Number(entry.cover.state === "pending"), 0);

/** How many downloads the circuit breaker samples: the first, the middle and the last pending one (all of them when fewer). */
function pickProbes(pending: readonly TrackEntry[]): TrackEntry[] {
  const at = [...new Set([0, Math.floor(pending.length / 2), pending.length - 1])].filter((i) => i >= 0 && i < pending.length);
  return at.map((i) => pending[i]).filter((entry): entry is TrackEntry => entry !== undefined);
}

/** What a refusal a circuit breaker counts is called (`status-403`, `blocked-address`), or null for any other failure. */
function refusalSignature(audio: Audio): string | null {
  if (audio.state !== "failed") return null;
  return /^status-(401|403|429)$/.test(audio.reason) || audio.reason === "blocked-address" ? audio.reason : null;
}

function reasonOf(error: unknown): string {
  if (error instanceof DownloadError) return error.kind === "status" && error.status !== null ? `status-${error.status}` : error.kind;
  if (error instanceof DecodeError) return `decode:${error.kind}`;
  return "write-failed";
}

export { TrackUnavailableError } from "./renderTrack";

export class TrackStore implements MusicListSink, RenderTrackSource {
  readonly persistent = true;
  readonly #deps: TrackStoreDeps;
  readonly #decode: (options: DecodeOptions) => Promise<DecodeResult>;
  readonly #inspect: (path: string, signal: AbortSignal) => Promise<readonly string[]>;
  #record: ListRecord | null;
  #busy = false;

  private constructor(deps: TrackStoreDeps, record: ListRecord | null) {
    this.#deps = deps;
    this.#decode = deps.decode ?? decodeAudio;
    this.#inspect = deps.inspect ?? ((path, signal) => inspectStreams({ path, signal }));
    this.#record = record;
  }

  /** Opens what an earlier run left: sweeps crash leftovers, reads the record, and drops what the disk or the clock no longer backs. Never throws. */
  static async open(deps: TrackStoreDeps): Promise<TrackStore> {
    for (const folder of ["lists", "tracks", "covers", "peaks"]) {
      const names = await readdir(join(deps.dir, folder)).catch(() => [] as string[]);
      for (const name of names) if (isTempName(name)) await rm(join(deps.dir, folder, name), { force: true }).catch(() => undefined);
    }
    const loaded = await TrackStore.#load(deps);
    const store = new TrackStore(deps, loaded);
    store.#record = await store.#reconcile(loaded);
    // A signed URL that expired while the app was closed is of no use: the record stops holding it (best effort).
    if (loaded !== null && store.#record !== null && countPending(store.#record) < countPending(loaded)) {
      await writeJsonAtomic(join(deps.dir, "lists", "current.json"), store.#record).catch(() => deps.log("studio engine: the music list record could not be rewritten"));
    }
    return store;
  }

  /** How many downloads (a track's audio or a cover) are still to run, from URLs that have not expired. */
  pendingCount(): number {
    return this.#record === null ? 0 : countPending(this.#record);
  }

  /**
   * Finishes what an earlier run left pending (a stop or a crash after the request was spent), with the URLs its record
   * kept and only until they expire. Nothing is requested when nothing is pending. Same rules and same failure handling
   * as `accept`; a pending URL is checked against the host policy again by the download itself.
   */
  async resume(progress: (done: number, total: number) => void, signal: AbortSignal): Promise<void> {
    if (this.#busy) throw new SinkError("a music refresh is already being stored");
    if (this.pendingCount() === 0) return;
    this.#busy = true;
    try {
      await this.#download(progress, signal);
    } finally {
      this.#busy = false;
    }
  }

  static async #load(deps: TrackStoreDeps): Promise<ListRecord | null> {
    const path = join(deps.dir, "lists", "current.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return null;
    }
    let why = "it is not valid JSON";
    try {
      const json: unknown = JSON.parse(text);
      const read = ListRecordSchema.safeParse(json);
      if (read.success) return read.data;
      const version = typeof json === "object" && json !== null ? Reflect.get(json, "v") : undefined;
      why = typeof version === "number" && version > 1 ? "it was written by a newer version" : "it does not match the record format";
    } catch {
      // Not JSON: `why` says so.
    }
    // Set aside, never overwritten: the owner (or a newer Studio) may want it.
    deps.log(`studio engine: the music list record could not be read (${why}); it was set aside and the store starts empty`);
    // The copy keeps no signed URL (review F6): a pending one would sit on disk long after it stopped working. If the
    // scrubbed copy cannot be written the original is moved aside as it is, which loses nothing.
    const aside = `${path}.${deps.clock()}`;
    let copied = false;
    try {
      const scrubbed = scrubUrls(text);
      // An original that will not go is met again at every open: one copy of the same content is enough.
      const names = await readdir(dirname(path)).catch(() => [] as string[]);
      let already = false;
      // The copies of THIS file: named like it, then a dot and a time.
      for (const name of names.filter((candidate) => candidate.startsWith(`${basename(path)}.`))) {
        if ((await readFile(join(dirname(path), name), "utf8").catch(() => null)) === scrubbed) already = true;
      }
      if (!already) await writeFileAtomic(aside, scrubbed);
      copied = true;
    } catch {
      // The scrubbed copy could not be written: the original is moved aside as it is, which loses nothing.
      await renameWithRetry(path, aside).catch(() => undefined);
    }
    // Never a rename after a good copy: that would put the unscrubbed original over it. An original that will not go stays
    // where it is (the next refresh replaces it) and is said so.
    if (copied) await (deps.removeFile ?? ((file) => rm(file, { force: true })))(path).catch(() => deps.log("studio engine: the set-aside music list record could not be removed"));
    return null;
  }

  /** The record as the disk and the clock leave it: a stored file that is gone or changed size, and a URL past its time, are not held. */
  async #reconcile(record: ListRecord | null): Promise<ListRecord | null> {
    if (record === null) return null;
    const now = this.#deps.clock();
    const tracks: TrackEntry[] = [];
    for (const entry of record.tracks) {
      let audio: Audio = entry.audio;
      let cover: Cover = entry.cover;
      if (audio.state === "stored" && !(await isRegularFileOfSize(this.#trackPath(entry.trackId), audio.bytes))) audio = { state: "failed", reason: "missing" };
      if (audio.state === "pending" && audio.expiresAt <= now) audio = { state: "failed", reason: "expired" };
      if (cover.state === "stored" && !(await isRegularFileOfSize(this.#coverPath(entry.trackId, cover.ext), cover.bytes))) cover = { state: "failed", reason: "missing" };
      if (cover.state === "pending" && cover.expiresAt <= now) cover = { state: "failed", reason: "expired" };
      tracks.push({ ...entry, audio, cover });
    }
    return { ...record, tracks };
  }

  // ---------- paths: an id and a fixed name, never anything else ----------

  #trackPath(trackId: string): string {
    return join(this.#deps.dir, "tracks", `${TrackStore.#safeId(trackId)}.m4a`);
  }

  #coverPath(trackId: string, ext: CoverExtension): string {
    return join(this.#deps.dir, "covers", `${TrackStore.#safeId(trackId)}.${ext}`);
  }

  #peaksPath(trackId: string): string {
    return join(this.#deps.dir, "peaks", `${TrackStore.#safeId(trackId)}.json`);
  }

  static #safeId(trackId: string): string {
    if (!Id.safeParse(trackId).success) throw new TypeError("a track id is not a safe file name");
    return trackId;
  }

  #say(line: string): void {
    try {
      this.#deps.log(line);
    } catch {
      // A logger must never stop a download.
    }
  }

  // ---------- reading ----------

  summary(): { listFetchedAt: number | null; trackCount: number; bytesOnDisk: number } {
    const record = this.#record;
    if (record === null) return { listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 };
    let trackCount = 0;
    let bytesOnDisk = 0;
    for (const entry of record.tracks) {
      if (entry.audio.state === "stored") {
        bytesOnDisk += entry.audio.bytes;
        if (entry.inList) trackCount++;
      }
      if (entry.cover.state === "stored") bytesOnDisk += entry.cover.bytes;
    }
    return { listFetchedAt: record.fetchedAt, trackCount, bytesOnDisk };
  }

  /** The tracks of the current list whose audio is stored, at most 100, in list order (`music.list`). */
  list(): TrackSummary[] {
    const record = this.#record;
    if (record === null) return [];
    return record.tracks
      .filter((entry) => entry.inList && entry.audio.state === "stored")
      .slice(0, MAX_LISTED_TRACKS)
      .map(toSummary);
  }

  /** Whether a track's audio is stored (of any list, not only the current one). */
  hasTrack(trackId: string): boolean {
    return this.#record?.tracks.some((entry) => entry.trackId === trackId && entry.audio.state === "stored") ?? false;
  }

  /** The proven length of a stored track (of any list), from the record alone: no disk, no ffmpeg. Null for any id that is not stored. */
  stored(trackId: string): { readonly decodedMs: number } | null {
    if (!Id.safeParse(trackId).success) return null;
    const audio = this.#record?.tracks.find((entry) => entry.trackId === trackId)?.audio;
    return audio?.state === "stored" ? { decodedMs: audio.decodedMs } : null;
  }

  /**
   * The track's file for a render (invariant 31): the path is built here from the id, and the track is checked again NOW, at
   * the render, because the file has sat on disk since the download. A stored entry, a plain file (no link followed) of the
   * recorded size and sha256, and exactly one audio stream by ffmpeg's own reading. Anything else is a `TrackUnavailableError`
   * and the render never starts ffmpeg on the file. A cancel is the signal's own reason.
   */
  async openForRender(trackId: string, signal: AbortSignal): Promise<RenderTrack> {
    signal.throwIfAborted();
    const entry = Id.safeParse(trackId).success ? this.#record?.tracks.find((candidate) => candidate.trackId === trackId) : undefined;
    const audio = entry?.audio;
    if (entry === undefined || audio?.state !== "stored") throw new TrackUnavailableError("not-stored");
    const path = this.#trackPath(trackId);
    let bytes: Uint8Array;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size !== audio.bytes || audio.bytes > TRACK_MAX_BYTES) throw new TrackUnavailableError("changed");
      bytes = new Uint8Array(await readFile(path));
    } catch {
      throw new TrackUnavailableError("changed");
    }
    if (bytes.byteLength !== audio.bytes || sha256(bytes) !== audio.sha256) throw new TrackUnavailableError("changed");
    signal.throwIfAborted();
    let kinds: readonly string[];
    try {
      kinds = await this.#inspect(path, signal);
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new TrackUnavailableError("not-audio");
    }
    if (kinds.length !== 1 || kinds[0] !== "Audio") throw new TrackUnavailableError("not-audio");
    return {
      path,
      bytes: audio.bytes,
      sha256: audio.sha256,
      decodedMs: audio.decodedMs,
      title: entry.title,
      artist: entry.artist,
      forbidden: trackForbiddenStrings(bytes, [entry.title, entry.artist]),
    };
  }

  /** A window of a stored track's waveform (`music.peaks`), or null when the track is not stored or its envelope cannot be trusted. */
  async peaks(trackId: string, startMs: number, durationMs: number, bars: number): Promise<number[] | null> {
    if (!Id.safeParse(trackId).success || !this.hasTrack(trackId)) return null;
    try {
      const path = this.#peaksPath(trackId);
      const info = await stat(path);
      if (!info.isFile() || info.size > ENVELOPE_MAX_FILE_BYTES) return null;
      const envelope = EnvelopeSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      return envelope.success ? windowPeaks(envelope.data, startMs, durationMs, bars) : null;
    } catch {
      return null;
    }
  }

  // ---------- refreshing ----------

  /**
   * Stores the list and downloads what it names. The record is on disk before the first request; a track that fails is
   * recorded and the rest go on; a cancel throws with what is still to do left pending (and its URLs, until they expire).
   * Rejects when the list cannot be stored, when a cancel came, or when not one track of a non-empty list could be stored.
   */
  async accept(list: FetchedList, progress: (done: number, total: number) => void, signal: AbortSignal): Promise<void> {
    if (this.#busy) throw new SinkError("a music refresh is already being stored");
    this.#busy = true;
    try {
      const planned = await this.#plan(list);
      for (const folder of ["lists", "tracks", "covers", "peaks"]) await mkdirDurable(join(this.#deps.dir, folder));
      await this.#persist(planned);
      await this.#download(progress, signal);
    } finally {
      this.#busy = false;
    }
  }

  async #persist(record: ListRecord): Promise<void> {
    await writeJsonAtomic(join(this.#deps.dir, "lists", "current.json"), record);
    this.#record = record;
  }

  /** A pending entry for a URL that passes the host policy now, else a failed one (the URL is dropped, never written). */
  #pending(url: string, fetchedAt: number, what: "track" | "cover"): { state: "pending"; url: string; expiresAt: number } | { state: "failed"; reason: string } {
    const checked = checkCdnUrl(url);
    if (!checked.ok) {
      this.#say(`studio engine: a ${what} URL was refused (${checked.reason}, host ${checked.host})`);
      return { state: "failed", reason: `refused-${checked.reason}` };
    }
    return { state: "pending", url, expiresAt: expiresAtFor(url, fetchedAt) };
  }

  /** The record for a new list: its tracks first (deduplicated by id, what is already stored kept), then the stored tracks of earlier lists. */
  async #plan(list: FetchedList): Promise<ListRecord> {
    const prior = new Map((this.#record?.tracks ?? []).map((entry) => [entry.trackId, entry]));
    const seen = new Set<string>();
    const entries: TrackEntry[] = [];
    for (const track of list.tracks) {
      if (!Id.safeParse(track.trackId).success) {
        this.#say("studio engine: a track with an unusable id was skipped");
        continue;
      }
      if (seen.has(track.trackId)) continue;
      seen.add(track.trackId);
      const before = prior.get(track.trackId);
      let audio: Audio = this.#pending(track.downloadUrl, list.fetchedAt, "track");
      if (before?.audio.state === "stored" && (await isRegularFileOfSize(this.#trackPath(track.trackId), before.audio.bytes))) audio = before.audio;
      let cover: Cover = track.coverUrl === null ? { state: "none" } : this.#pending(track.coverUrl, list.fetchedAt, "cover");
      if (before?.cover.state === "stored" && (await isRegularFileOfSize(this.#coverPath(track.trackId, before.cover.ext), before.cover.bytes))) cover = before.cover;
      entries.push({
        trackId: track.trackId,
        title: track.title,
        artist: track.artist,
        durationMs: track.durationMs,
        explicit: track.explicit,
        highlights: normaliseHighlights(track.highlightsMs, track.durationMs),
        monetization: track.monetization,
        licensedSubtype: track.licensedSubtype,
        inList: true,
        audio,
        cover,
      });
    }
    // Stage 3 prunes nothing: a track the new list dropped stays, with its cover, but is no longer offered.
    const kept = [...prior.values()]
      .filter((entry) => !seen.has(entry.trackId) && entry.audio.state === "stored")
      .map((entry): TrackEntry => ({ ...entry, inList: false, cover: entry.cover.state === "stored" ? entry.cover : { state: "none" } }));
    const room = Math.max(0, MAX_RECORDED_TRACKS - entries.length);
    if (kept.length > room) this.#say(`studio engine: ${kept.length - room} older tracks are no longer recorded (the record holds ${MAX_RECORDED_TRACKS})`);
    return { v: 1, fetchedAt: list.fetchedAt, complete: false, tracks: [...entries, ...kept.slice(0, room)] };
  }

  async #download(progress: (done: number, total: number) => void, signal: AbortSignal): Promise<void> {
    const start = this.#record;
    if (start === null) return;
    const wanted = start.tracks.filter((entry) => entry.audio.state === "pending" || entry.cover.state === "pending");
    const total = 1 + wanted.reduce((sum, entry) => sum + Number(entry.audio.state === "pending") + Number(entry.cover.state === "pending"), 0);
    let done = 1;
    progress(done, total);
    const record = (): ListRecord => this.#record ?? start;
    const persistEntry = (entry: TrackEntry): Promise<void> =>
      this.#persist({ ...record(), tracks: record().tracks.map((candidate) => (candidate.trackId === entry.trackId ? entry : candidate)) });
    // What follows an entry's audio: its cover (not worth a request for a track that could not be stored), then the record.
    const finishEntry = async (given: TrackEntry): Promise<void> => {
      let entry = given;
      if (entry.cover.state === "pending") {
        const cover: Cover = entry.audio.state === "stored" ? await this.#downloadCover(entry, entry.cover, signal) : { state: "failed", reason: "skipped" };
        entry = { ...entry, cover };
        progress(++done, total);
      }
      await persistEntry(entry);
    };

    // The circuit breaker. The request behind this list is spent and a failed entry erases its URL, so a batch of refusals
    // that one cause explains (a header a CDN wants, a changed host shape) must not close the record. Three downloads are
    // tried FIRST, spread over the list (first, middle, last) so that neighbours that are bad for their own reasons cannot
    // speak for the rest; with fewer than three pending, all of them are. If every one is refused the same way (401, 403,
    // 429, or an address that is not public) the run stops with every entry still pending and its URL kept, marked with
    // those tracks, and `resume` retries them at the next start with no new list. If the next run samples the same tracks
    // and they are refused again, they are given up on and the rest is saved.
    // A repeat counts only when the tracks AND the way they were refused are the same. Giving those three up is not a licence
    // for the rest: a NEW sample is taken from what remains, and a CDN-wide refusal that survives a restart (a header a CDN
    // wants, the likeliest first-real-refresh failure) costs three tracks per start, never the list.
    const mark = record().breaker;
    let remaining = wanted.filter((entry) => entry.audio.state === "pending");
    const handled = new Set<string>();
    for (;;) {
      const probes = pickProbes(remaining);
      if (probes.length === 0) break;
      const probed = new Map<string, Audio>();
      for (const probe of probes) {
        if (probe.audio.state !== "pending") continue;
        const audio = await this.#downloadTrack(probe, probe.audio, signal);
        progress(++done, total);
        probed.set(probe.trackId, audio);
        handled.add(probe.trackId);
        // Only a refusal is held back until the whole sample is known; anything else is recorded at once, so a stop in the
        // middle of the sample loses no stored track.
        if (refusalSignature(audio) === null) await finishEntry({ ...probe, audio });
      }
      const signatures = probes.map((probe) => refusalSignature(probed.get(probe.trackId) ?? probe.audio));
      const first = signatures[0] ?? null;
      const refusedAlike = first !== null && signatures.every((signature) => signature === first);
      if (refusedAlike) {
        const ids = probes.map((probe) => probe.trackId).sort();
        const repeat = mark !== undefined && mark.signature === first && mark.ids.join(",") === ids.join(",");
        if (!repeat) {
          // These stay pending with their URLs (they were held, never recorded): the mark says which and how.
          for (const probe of probes) handled.delete(probe.trackId);
          await this.#persist({ ...record(), breaker: { ids, signature: first } });
          this.#say(`studio engine: the ${probes.length} sampled downloads were all refused (${first}); the run was stopped and its downloads kept`);
          throw new SinkError(`the CDN refused the ${probes.length} sampled downloads (${first}); nothing more was requested, and the ${countPending(record())} downloads that remain are kept to retry at the next start`);
        }
        this.#say(`studio engine: the same ${probes.length} downloads were refused again (${first}); they are given up on, and a new sample is taken`);
      }
      for (const probe of probes) {
        const audio = probed.get(probe.trackId) ?? probe.audio;
        if (refusalSignature(audio) !== null) await finishEntry({ ...probe, audio });
      }
      // Given up, a sample leaves the remainder to a new sample; otherwise the sample has said enough and the rest goes on.
      if (!refusedAlike) break;
      const given = new Set(probes.map((probe) => probe.trackId));
      remaining = remaining.filter((entry) => !given.has(entry.trackId));
    }
    for (const entry of wanted) {
      if (handled.has(entry.trackId)) continue;
      const audio: Audio = entry.audio.state === "pending" ? await this.#downloadTrack(entry, entry.audio, signal) : entry.audio;
      if (entry.audio.state === "pending") progress(++done, total);
      await finishEntry({ ...entry, audio });
    }
    const { breaker: _cleared, ...rest } = record();
    await this.#persist({ ...rest, complete: true });
    // A refresh that stores nothing is a failure, whether its downloads failed or its URLs were refused before any request
    // (review F3): a paid list must not read as "done" with an empty catalogue.
    const listed = record().tracks.filter((entry) => entry.inList);
    if (listed.length > 0 && listed.every((entry) => entry.audio.state !== "stored")) {
      const reasons = new Map<string, number>();
      for (const entry of listed) if (entry.audio.state === "failed") reasons.set(entry.audio.reason, (reasons.get(entry.audio.reason) ?? 0) + 1);
      const summary = [...reasons].map(([reason, count]) => `${reason} x${count}`).join(", ");
      throw new SinkError(`none of the ${listed.length} tracks could be stored (${summary})`);
    }
  }

  /** Downloads, verifies and stores one track. Returns stored or failed; throws only for a cancel. */
  async #downloadTrack(entry: TrackEntry, pending: { url: string; expiresAt: number }, signal: AbortSignal): Promise<Audio> {
    const failed = (reason: string, detail: string): Audio => {
      this.#say(`studio engine: a track was not stored (${detail})`);
      return { state: "failed", reason };
    };
    if (pending.expiresAt <= this.#deps.clock()) return failed("expired", "its signed URL has expired");
    let got;
    try {
      got = await downloadCapped({ transport: this.#deps.transport, url: pending.url, maxBytes: TRACK_MAX_BYTES, signal, ...this.#deps.limits });
    } catch (error) {
      if (signal.aborted) throw new SinkError("the refresh was cancelled");
      return failed(reasonOf(error), error instanceof DownloadError ? error.message : "the download failed");
    }
    const probe = probeMp4Audio(got.bytes);
    if (!probe.ok) return failed(`probe:${probe.reason}`, `the file is not one AAC stream: ${probe.reason}`);

    const final = this.#trackPath(entry.trackId);
    const temp = tempSiblingPath(final);
    let peaksWritten = false;
    try {
      await writeFileDurable(temp, got.bytes);
      const decoded = await this.#decode({ path: temp, expectedMs: entry.durationMs, signal });
      // The waveform first: a track that is served always has one.
      await writeJsonAtomic(this.#peaksPath(entry.trackId), { v: 1, stepMs: PEAK_STEP_MS, peaks: decoded.peaks });
      peaksWritten = true;
      await renameWithRetry(temp, final);
      await fsyncDir(dirname(final));
      return {
        state: "stored",
        bytes: got.bytes.byteLength,
        sha256: sha256(got.bytes),
        audioObjectType: probe.info.audioObjectType,
        sampleRate: probe.info.sampleRate,
        channels: probe.info.channels,
        decodedMs: decoded.decodedMs,
      };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      if (peaksWritten) await rm(this.#peaksPath(entry.trackId), { force: true }).catch(() => undefined);
      if (signal.aborted) throw new SinkError("the refresh was cancelled");
      return failed(reasonOf(error), error instanceof DecodeError ? `the decode did not accept it: ${error.kind}` : "the file could not be written");
    }
  }

  /** Downloads and stores one cover. Never throws for a bad cover; throws only for a cancel. */
  async #downloadCover(entry: TrackEntry, pending: { url: string; expiresAt: number }, signal: AbortSignal): Promise<Cover> {
    const failed = (reason: string, detail: string): Cover => {
      this.#say(`studio engine: a cover was not stored (${detail})`);
      return { state: "failed", reason };
    };
    if (pending.expiresAt <= this.#deps.clock()) return failed("expired", "its signed URL has expired");
    let got;
    try {
      got = await downloadCapped({ transport: this.#deps.transport, url: pending.url, maxBytes: COVER_MAX_BYTES, signal, ...this.#deps.limits });
    } catch (error) {
      if (signal.aborted) throw new SinkError("the refresh was cancelled");
      return failed(reasonOf(error), error instanceof DownloadError ? error.message : "the download failed");
    }
    const ext = sniffCover(got.bytes);
    if (ext === null) return failed("cover-not-image", "the bytes are not a JPEG, a PNG or a WebP");
    try {
      await writeFileAtomic(this.#coverPath(entry.trackId, ext), got.bytes);
      // Another extension left by an earlier cover would be served first by the media route: only one may exist.
      for (const other of COVER_EXTENSIONS) if (other !== ext) await rm(this.#coverPath(entry.trackId, other), { force: true }).catch(() => undefined);
      return { state: "stored", ext, bytes: got.bytes.byteLength, sha256: sha256(got.bytes) };
    } catch {
      return failed("write-failed", "the cover could not be written");
    }
  }
}

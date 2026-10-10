import type { SliceStatus } from "../sceneSets/launchDraw";
import type { ExportUnavailableReason } from "../../shared/engine";
import type { RenderFailureFacts, RenderLife } from "./freeSteps";
import { NETWORK_WAITS_MS } from "./paidFailures";
import { UNTITLED } from "../music/trackRecord";
import type { PublishedRead } from "../videos/published";
import { capFundsResume } from "../runs/remaining";

// Stage 4, S4.6w (plan §25): the pure parts of the engine's DEFAULT wiring of the autopilot steps. The engine builds `composeSteps(createPaidSteps(...), createFreeSteps(...))` out of its own
// parts (`Engine#launchSteps`); what is decided here is decided without the engine, so a test can ask it in one line.

/**
 * Q2 (plan §17, the owner has not answered; the plan's default stands): a job whose requests got no answer continues by itself after 1 minute at its first drop and after 5 at its second, and the
 * third drop holds for a person. Q2 = Б is `[]` (the first drop holds). The value lives ONCE, as `NETWORK_WAITS_MS` in `paidFailures.ts`, which is also what the paid steps use when they are given
 * none; the engine hands it over explicitly through this name, so the choice is visible where the steps are built and a test pins it.
 */
export const AUTOPILOT_NETWORK_WAITS_MS: readonly number[] = NETWORK_WAITS_MS;

/** How long the free steps wait for one read of the library's side (the drafts that hold photos, the slice runs, an avatar's track usage). A folder that does not answer is «unknown», which waits; it never hangs a launch. */
export const AUTOPILOT_READ_TIMEOUT_MS = 15_000;

/** S4.10 fix B: how long each figure of the launch estimate that reads the world (the OpenRouter balance, the export volume's free bytes, the music candidates) may take. The plan card is asked for while the owner waits, so it is short. */
export const AUTOPILOT_PREVIEW_READ_MS = 2_000;

/**
 * `work()` with a bound: rejects, naming the read, when it does not answer in `ms`. The timer is cleared as soon as the read settles and is NOT unref'd: a drain waits on a read, and a read
 * that never answers must end by this timer and not by the process dying. A read that throws at once is a rejection.
 */
export async function boundedRead<T>(work: () => Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Like `boundedRead`, but a read that is already out for `key` is joined, not asked again: on a share that does not answer, every pass of the free steps (every second, and at every poke) would
 * otherwise leave one more hung call in the thread pool the ledger writes share. Each caller keeps its own bound. The flight is forgotten when the underlying read settles, with its answer or its
 * failure: nothing is cached.
 */
export function boundedSingleFlight<T>(ms: number, what: string): (key: string, work: () => Promise<T>) => Promise<T> {
  const flights = new Map<string, Promise<T>>();
  return (key, work) => {
    let flight = flights.get(key);
    if (flight === undefined) {
      const started = Promise.resolve().then(work);
      flights.set(key, started);
      const forget = (): void => {
        if (flights.get(key) === started) flights.delete(key);
      };
      started.then(forget, forget);
      flight = started;
    }
    const joined = flight;
    return boundedRead(() => joined, ms, what);
  };
}

// ---------- the results' reads of the library (S4.6g) ----------

export interface BoundedVideoFactsDeps {
  readonly timeoutMs: number;
  /** Whether `root` is the library that is open now: a read for a library that has been switched away from says nothing. */
  isLive(root: string): boolean;
  listRecordIds(root: string, avatarId: string): Promise<Set<string> | null>;
  readMarks(root: string, avatarId: string): Promise<PublishedRead>;
}

/**
 * The two reads `autopilot.get` / `autopilot.list` make of an avatar (its record ids, its published log), each bounded for every caller and single-flight per `[root, avatarId]`, so a
 * share that does not answer leaves one hung call, not one per `autopilot.changed`, in the thread pool the ledger's writes share. A timeout, a failure or a root that is no longer the
 * open library reads as «cannot tell»: `null` records (never «removed») and an `unknown` log.
 */
export function boundedVideoFacts(deps: BoundedVideoFactsDeps): {
  recordIds(root: string, avatarId: string): Promise<Set<string> | null>;
  publishedMarks(root: string, avatarId: string): Promise<PublishedRead>;
} {
  const recordsRead = boundedSingleFlight<Set<string> | null>(deps.timeoutMs, "the record ids of the avatar");
  const marksRead = boundedSingleFlight<PublishedRead>(deps.timeoutMs, "the published marks of the avatar");
  const unknown: PublishedRead = { state: "unknown", reason: "corrupt" };
  return {
    recordIds: (root, avatarId) => (deps.isLive(root) ? recordsRead(JSON.stringify([root, avatarId]), () => deps.listRecordIds(root, avatarId)).catch(() => null) : Promise.resolve(null)),
    publishedMarks: (root, avatarId) => (deps.isLive(root) ? marksRead(JSON.stringify([root, avatarId]), () => deps.readMarks(root, avatarId)).catch(() => unknown) : Promise.resolve(unknown)),
  };
}

// ---------- the slices of a launch, as the free steps ask ----------

/** What decides whether a slice that has open slots is over for good (`isSpentSlice`). */
export interface SpentSliceFacts {
  /** Slots of the run with no end. */
  readonly openSlots: number;
  /** A job of the run is live. */
  readonly running: boolean;
  /** The run's own open reserves wait for a reconcile: they count at their worst case until then, so the room is not final. */
  readonly needsReconcile: boolean;
  readonly capMicros: number;
  readonly committedMicros: number;
  /** The cheapest next attempt (`remainingPlan`), null when there is nothing to send. */
  readonly minToProgressMicros: number | null;
  /** The engine saw the run's job end on a cap (`RUN_CAP_EXCEEDED`), which may be the LAUNCH group's cap: the run's own cap can still show room. */
  readonly endedByCap: boolean;
}

/**
 * A slice whose slots stay open because a cap ended it: nothing runs, nothing is waiting for a reconcile, and either its own cap cannot fund the next attempt (the very test `#remaining` applies:
 * `capFundsResume`) or the engine saw it end on a cap. The paid side treats such a slice as spent and moves on, so the free side must read it as ENDED too, or the draw is never «over».
 */
export function isSpentSlice(facts: SpentSliceFacts): boolean {
  if (facts.openSlots === 0 || facts.running || facts.needsReconcile) return false;
  return facts.endedByCap || !capFundsResume({ capMicros: facts.capMicros }, facts.committedMicros, facts.minToProgressMicros);
}

/** One scene set of the launch with the status of each of its slice runs, as the engine read them. */
export interface SliceFactsSet {
  /** The approval's frozen draw (`launchDraw`): undefined before the owner's review or the launch's own approval. */
  readonly draw: { readonly sceneIds: readonly number[]; readonly slices: readonly { readonly runId: string; readonly sceneIds: readonly number[] }[] } | undefined;
  /** A status for each slice that has a run folder; a slice without one is a draw a crash left half-made, or not made yet. */
  readonly statuses: ReadonlyMap<string, SliceStatus>;
}

/**
 * What the free steps need of the paid draw (`FreeStepsDeps.sliceRuns`): the slice runs that are FINISHED (every slot closed, no job running), and whether the draw is OVER, which is true only when
 * no slice will start again: the frozen list is drawn to its last scene and every slice has ended. The list is the one the approval froze, so scenes the owner removed in the review are not
 * waited for. Scenes still to be drawn keep the draw open however long the launch sits in a paid hold: a hold is not the end, and videos that wait for photos must not be degraded behind it.
 * `unreadable` set files may hold slices nobody can see: the draw is then never over.
 */
export function sliceFactsOf(sets: readonly SliceFactsSet[], unreadable: number): { runIds: string[]; over: boolean } {
  const runIds: string[] = [];
  let over = unreadable === 0 && sets.length > 0;
  for (const { draw, statuses } of sets) {
    if (draw === undefined) {
      over = false;
      continue;
    }
    const drawn = new Set(draw.slices.flatMap((slice) => slice.sceneIds));
    if (!draw.sceneIds.every((id) => drawn.has(id))) over = false;
    for (const slice of draw.slices) {
      const status = statuses.get(slice.runId);
      if (status?.finished === true) runIds.push(slice.runId);
      else over = false;
    }
  }
  return { runIds, over };
}

// ---------- the render queue, as the free steps ask ----------

/** What the wiring reads of a job state: every kind has a job id and a status; a render also has its video and, for the launch's own, the launch. */
export interface JobFacts {
  readonly kind: string;
  readonly jobId: string;
  readonly status: string;
  readonly videoId?: string | undefined;
  readonly launchId?: string | undefined;
  /** How a failed job ended (the registry's job state carries it exactly when the job failed). */
  readonly error?: { readonly code: string; readonly exportReason?: ExportUnavailableReason | undefined } | undefined;
}

const LIVES: readonly RenderLife[] = ["queued", "running", "done", "failed", "cancelled"];
const lifeOf = (status: string): RenderLife => LIVES.find((life) => life === status) ?? "gone";

/** Where a render job stands; `gone` for a job the registry has forgotten, and for the id of a job that is not a render. */
export function renderLifeOf(states: readonly JobFacts[], jobId: string): RenderLife {
  const state = states.find((s) => s.kind === "render" && s.jobId === jobId);
  return state === undefined ? "gone" : lifeOf(state.status);
}

/** How a failed render job ended (S4.6r): its error's code and, for `EXPORT_UNAVAILABLE`, the folder's reason. Undefined for a job that did not fail, one that is not a render, and one the registry forgot. */
export function renderFailureOf(states: readonly JobFacts[], jobId: string): RenderFailureFacts | undefined {
  const state = states.find((s) => s.kind === "render" && s.jobId === jobId);
  if (state === undefined || state.status !== "failed" || state.error === undefined) return undefined;
  return { code: state.error.code, exportReason: state.error.exportReason };
}

/** The render jobs that are queued or running and carry a launch id: the ones a launch that lost track of its render can take back. */
export function liveRendersOf(states: readonly JobFacts[]): Array<{ jobId: string; videoId: string; life: RenderLife }> {
  return states.flatMap((s) => {
    if (s.kind !== "render" || s.launchId === undefined || s.videoId === undefined) return [];
    const life = lifeOf(s.status);
    return life === "queued" || life === "running" ? [{ jobId: s.jobId, videoId: s.videoId, life }] : [];
  });
}

// ---------- the results list ----------

/** What a trend the list gave no title is called: neutral, never its raw id. The very words the music screen uses (`music/trackRecord.ts`). */
export const UNTITLED_TRACK = UNTITLED;

/** An own track is named by its file without the extension («my-song.m4a» is «my-song»). Only an extension with a letter in it is cut: «Song 2.0» and «Song.2024» are kept whole, and so is a name that is only an extension. */
export function ownTrackTitle(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return fileName;
  return /^(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,5}$/.test(fileName.slice(dot + 1)) ? fileName.slice(0, dot) : fileName;
}

/** The longest title or artist the contract takes. */
const LABEL_MAX = 120;

/** `text` trimmed, cut to the contract's 120 characters without leaving half of a surrogate pair, and trimmed again; null when nothing is left. */
function labelPart(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  let cut = text.trim().slice(0, LABEL_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  cut = cut.trim();
  return cut === "" ? null : cut;
}

/**
 * The title and artist of a track as the results list takes them (`LaunchVideo.track`: a title of 1 to 120 characters, an artist of 1 to 120 or null). A title that names nothing is null, and the list
 * titles the video by the track's id instead.
 */
export function normalizeTrackLabel(title: string | null | undefined, artist: string | null | undefined): { title: string; artist: string | null } | null {
  const name = labelPart(title);
  return name === null ? null : { title: name, artist: labelPart(artist) };
}

/** What `SpentSlices.judge` is told of a slice. The cap figures arrive lazily: the price list is read only when the cheap facts leave the question open. */
export interface SpentSliceQuestion {
  readonly openSlots: number;
  readonly running: boolean;
  readonly needsReconcile: boolean;
  readonly capMicros: number;
  readonly committedMicros: number;
  readonly endedByCap: boolean;
  /** The cheapest next attempt at today's prices, or null when it cannot be known now. Called at most once, and only when needed. */
  minToProgress(): Promise<number | null>;
}

export interface SpentSlices {
  judge(runId: string, question: SpentSliceQuestion): Promise<boolean>;
  /** Whether the slice was already judged spent, with no judging: no price is read and nothing is latched (a free read-only command may ask). */
  peek(runId: string): boolean;
}

/**
 * `isSpentSlice` with two additions. The cheap checks (nothing open, a live job, a pending reconcile, an end seen on a cap) come BEFORE the price list is read, so a stale price cache
 * (a fetch that may take as long as the read timeout) cannot turn a question the cheap facts answer into a timeout. And spent is LATCHED for the life of this object: the paid side sizes the
 * next slice from the unspent cap of a slice it counts as spent, so a slice that later reads as live again (prices fell, the process restarted) would hand that cap out twice.
 */
export function createSpentSlices(): SpentSlices {
  const latched = new Set<string>();
  return {
    async judge(runId, question) {
      if (latched.has(runId)) return true;
      if (question.openSlots === 0 || question.running || question.needsReconcile) return false;
      const spent = question.endedByCap || isSpentSlice({ ...question, minToProgressMicros: await question.minToProgress() });
      if (spent) latched.add(runId);
      return spent;
    },
    peek: (runId) => latched.has(runId),
  };
}

/** The label of a saved trend: its title and artist as the list recorded them, a missing or blank title as the neutral name (never the raw id). */
export function trendTrackLabel(title: string | null | undefined, artist: string | null | undefined): { title: string; artist: string | null } {
  return normalizeTrackLabel(title, artist) ?? { title: UNTITLED_TRACK, artist: labelPart(artist) };
}

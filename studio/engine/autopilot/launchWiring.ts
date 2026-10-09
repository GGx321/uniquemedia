import type { SliceStatus } from "../sceneSets/launchDraw";
import type { RenderLife } from "./freeSteps";
import { NETWORK_WAITS_MS } from "./paidFailures";

// Stage 4, S4.6w (plan §25): the pure parts of the engine's DEFAULT wiring of the autopilot steps. The engine builds `composeSteps(createPaidSteps(...), createFreeSteps(...))` out of its own
// parts (`Engine#launchSteps`); what is decided here is decided without the engine, so a test can ask it in one line.

/**
 * Q2 (plan §17, the owner has not answered; the plan's default stands): a job whose requests got no answer continues by itself after 1 minute at its first drop and after 5 at its second, and the
 * third drop holds for a person. Q2 = Б is `[]` (the first drop holds). This is the ONE place the setting is read: the wiring hands it to the paid steps and nothing else looks at it.
 */
export const AUTOPILOT_NETWORK_WAITS_MS: readonly number[] = NETWORK_WAITS_MS;

/** How long the free steps wait for one read of the library's side (the drafts that hold photos, the slice runs, an avatar's track usage). A folder that does not answer is «unknown», which waits; it never hangs a launch. */
export const AUTOPILOT_READ_TIMEOUT_MS = 15_000;

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

// ---------- the slices of a launch, as the free steps ask ----------

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
}

const LIVES: readonly RenderLife[] = ["queued", "running", "done", "failed", "cancelled"];
const lifeOf = (status: string): RenderLife => LIVES.find((life) => life === status) ?? "gone";

/** Where a render job stands; `gone` for a job the registry has forgotten, and for the id of a job that is not a render. */
export function renderLifeOf(states: readonly JobFacts[], jobId: string): RenderLife {
  const state = states.find((s) => s.kind === "render" && s.jobId === jobId);
  return state === undefined ? "gone" : lifeOf(state.status);
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

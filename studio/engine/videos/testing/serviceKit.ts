import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MontageDraft } from "../../../shared/engine/montage";
import { EventMessage, type UnsequencedEvent } from "../../../shared/engine";
import type { RunFfmpegArgvOptions } from "../../../node/runFfmpeg";
import { JobRegistry } from "../../jobs";
import type { Library } from "../../library";
import { RenderQueue } from "../../renderQueue/queue";
import { FileStateChecker } from "../fileState";
import { CommitTracker } from "../live";
import { VideoService, type VideoServiceDeps } from "../service";
import { acceptingVerify, fakeVideoBytes, type World } from "./kit";

// Test support for the video service (3a.8b.2): a service over a real library, a real export root and a real queue,
// with the export check, the focus resolver and ffmpeg replaced by scripted ones. Test-only.

export const BYTES = fakeVideoBytes(4096, 11);

/**
 * What a real ffmpeg reports for the pass-1 call of an own video clip: exactly the frames its graph stops at (`trim=end_frame=N`). The runner holds a video clip to the count ffmpeg
 * REPORTS (and fails closed when none is), so a fake that writes the file must say it. True when the call was a video clip's (and its count was reported).
 */
export function reportVideoClipFrames(opts: Pick<RunFfmpegArgvOptions, "argv" | "onFrames">): boolean {
  const graph = opts.argv[opts.argv.indexOf("-filter_complex") + 1] ?? "";
  const stop = /^\[0:v:0\]trim=end_frame=(\d+),/.exec(graph);
  if (stop === null) return false;
  opts.onFrames?.(Number(stop[1]));
  return true;
}

/** A fake ffmpeg: every call writes its output file, as a successful one would. */
export const writingRun = async (opts: RunFfmpegArgvOptions): Promise<void> => {
  reportVideoClipFrames(opts);
  await mkdir(dirname(opts.output), { recursive: true });
  await writeFile(opts.output, BYTES);
};

/** `library` with some methods replaced, still bound to the real instance (its private state lives there). */
export function withOverrides(library: Library, patch: Partial<Record<keyof Library, unknown>>): Library {
  return new Proxy(library, {
    get(target, property) {
      if (typeof property === "string" && property in patch) return Reflect.get(patch, property);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A focus resolver that fills every null focus with (0.5, 0.4), and says which specs it saw. */
export function fillingFocus(seen: MontageDraft[] = []): { fillMissingFocus: (spec: MontageDraft) => Promise<{ spec: MontageDraft; unresolved: [] }> } {
  return {
    fillMissingFocus: async (spec) => {
      seen.push(spec);
      const fill = <C extends { focus: { x: number; y: number } | null }>(cell: C): C => ({ ...cell, focus: cell.focus ?? { x: 0.5, y: 0.4 } });
      const clips = spec.clips.map((clip) => {
        if (clip.kind === "photo") return { ...clip, cell: fill(clip.cell) };
        if (clip.kind === "collage") return { ...clip, cells: clip.cells.map(fill) };
        return { ...clip, focus: clip.focus ?? { x: 0.5, y: 0.4 } };
      });
      return { spec: { ...spec, clips }, unresolved: [] };
    },
  };
}

export interface ServiceRig {
  readonly w: World;
  readonly service: VideoService;
  readonly queue: RenderQueue;
  readonly jobs: JobRegistry;
  readonly tracker: CommitTracker;
  readonly checker: FileStateChecker;
  readonly events: UnsequencedEvent[];
  readonly logs: string[];
  /** The avatar ids `announceAvatar` was asked for, in order (each is an `avatar.changed` in the engine). */
  readonly announced: string[];
  /** The `requiredBytes` of every export check made. */
  readonly checks: Array<number | undefined>;
  /** Every event, stamped the way the engine's log stamps it, so the contract's schema can judge it. */
  stamped(): EventMessage[];
  deps: VideoServiceDeps;
}

export interface ServiceRigOptions {
  library?: Library;
  deps?: Partial<VideoServiceDeps>;
  size?: number;
}

let ids = 0;

export function serviceRig(w: World, options: ServiceRigOptions = {}): ServiceRig {
  const library = options.library ?? w.library;
  const { renderOverrides, ...otherDeps } = options.deps ?? {};
  const tracker = new CommitTracker();
  const checker = new FileStateChecker();
  const jobs = new JobRegistry();
  const events: UnsequencedEvent[] = [];
  const logs: string[] = [];
  const announced: string[] = [];
  const checks: Array<number | undefined> = [];
  const holder: { service?: VideoService } = {};
  const queue = new RenderQueue({
    jobs,
    size: () => options.size ?? 1,
    onEvent: (event) => holder.service?.onQueueEvent(event),
    onListenerError: (error) => holder.service?.onListenerError(error),
  });
  const deps: VideoServiceDeps = {
    queue,
    tracker,
    checker,
    withLibrary: (work) => work(library),
    openLibrary: () => library,
    checkExport: async (requiredBytes) => {
      checks.push(requiredBytes);
      return { ok: true, root: w.exportRoot, rootId: w.rootId };
    },
    caseProbe: { isCaseInsensitive: async () => false },
    focus: () => fillingFocus(),
    renderTmpDir: w.renderTmp,
    newId: () => `id-${String(++ids).padStart(8, "0")}`,
    now: () => new Date(2026, 8, 29, 10, 0, 0),
    emit: (event) => void events.push(event),
    log: (line) => void logs.push(line),
    // The scripted ffmpeg and verifier are the defaults; a test that swaps one (a faulty `fs`, a hook, a refusing `verify`) keeps the
    // other. Without the merge, such a test silently ran REAL ffmpeg and the real verifier (0.5 s on a quiet Mac, 1.7 s on Windows).
    renderOverrides: { verify: acceptingVerify, ...renderOverrides, runDeps: { run: writingRun, ...renderOverrides?.runDeps } },
    announceAvatar: (_library, avatarId) => void announced.push(avatarId),
    staleRetryDelaysMs: [5, 5, 5],
    ...otherDeps,
  };
  const service = new VideoService(deps);
  holder.service = service;
  return {
    w,
    service,
    queue,
    jobs,
    tracker,
    checker,
    events,
    logs,
    announced,
    checks,
    deps,
    stamped: () => events.map((event, i) => EventMessage.parse({ ...event, seq: i + 1, bootId: "boot-0000-aaaa" })),
  };
}

/** A manual clock for the service's background timers: `advance` fires what falls due, in order, and lets promise continuations settle. */
export class FakeTimers {
  now = 0;
  #next = 0;
  #pending: Array<{ id: number; at: number; fn: () => void }> = [];

  set = (fn: () => void, ms: number): number => {
    const id = ++this.#next;
    this.#pending.push({ id, at: this.now + ms, fn });
    return id;
  };
  clear = (handle: unknown): void => {
    this.#pending = this.#pending.filter((t) => t.id !== handle);
  };
  /** When each pending timer falls due, relative to now. */
  get delays(): number[] {
    return this.#pending.map((t) => t.at - this.now).sort((a, b) => a - b);
  }
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = this.#pending.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.#pending = this.#pending.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.now = until;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** The one wait for a condition (15 s ceiling, not a cost: a satisfied wait returns at once): this file used to keep its own copy at 5 s, which missed the raise made for slow Windows runners. */
export { until } from "../../testing/engineHarness";

/** A one-shot signal a test hands to a stubbed step: `fire` says «I got here», `fired` is what the test waits on (no polling, no wall-clock budget). */
export function latch(): { fired: Promise<void>; fire: () => void } {
  let fire: () => void = () => undefined;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire };
}
